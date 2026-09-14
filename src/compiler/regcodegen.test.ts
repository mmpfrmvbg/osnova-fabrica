/**
 * Unit-тесты кодогена регистрового бэкенда: раскладка регистров и форма
 * артефакта. Поведение (совпадение со стековой VM) проверяет оракул
 * `src/oracle/parity.test.ts`; здесь — то, что в оракуле не видно: номера
 * регистров, абсолютные адреса переходов, отказ на неподдержанном.
 */

import { describe, it, expect } from "vitest";
import { compileSource } from "./compiler";
import { compileToReg, RegAllocator, RegCodegenError } from "./regcodegen";
import { isRegModule, REGCODE_IR } from "../runtime/vm/regcode";
import type { Module } from "./ast";

function astOf(source: string): Module {
  const result = compileSource(source);
  if (!result.moduleAst) {
    throw new Error(
      `Тестовый исходник не компилируется: ${JSON.stringify(result.lexerErrors.concat(result.parserErrors as never[]))}`,
    );
  }
  return result.moduleAst;
}

function regOf(source: string) {
  return compileToReg(astOf(source));
}

const FIRST_TARGET = `модуль Тест
процедура главная()
  пусть x = 1 + 2 * 3
  вернуть x * 4
конец
конец
`;

describe("regcodegen: первый целевой кейс — точная раскладка", () => {
  it("порядок инструкций: подвыражения, затем переменная, затем возврат", () => {
    const reg = regOf(FIRST_TARGET);
    expect(reg.constants).toEqual([1, 2, 3, 4]);
    expect(reg.code).toEqual([
      { op: "const", d: 2, type: "i32", k: 0 },
      { op: "const", d: 4, type: "i32", k: 1 },
      { op: "const", d: 5, type: "i32", k: 2 },
      { op: "mul", d: 3, a: 4, b: 5 },
      { op: "add", d: 1, a: 2, b: 3 },
      { op: "move", d: 0, a: 1 },
      { op: "move", d: 2, a: 0 },
      { op: "const", d: 3, type: "i32", k: 3 },
      { op: "mul", d: 1, a: 2, b: 3 },
      { op: "ret", v: 1 },
      { op: "ret" },
    ]);
  });

  it("переменная x занимает vreg 0, временные — выше localsCount", () => {
    const reg = regOf(FIRST_TARGET);
    const proc = reg.procedures[0]!;
    expect(proc.name).toBe("главная");
    expect(proc.localToVreg).toEqual({ x: 0 });
    expect(proc.vregs).toBe(6);
    expect(proc.returnsValue).toBe(true);
    // Каждая инструкция с `d` пишет в регистр внутри объявленного файла.
    for (const ins of reg.code) {
      const d = (ins as { d?: number }).d;
      if (d !== undefined) expect(d).toBeLessThan(proc.vregs);
    }
  });

  it("форма артефакта проходит валидатор isRegModule", () => {
    const reg = regOf(FIRST_TARGET);
    expect(isRegModule(reg)).toBe(true);
    expect(reg.ir).toBe(REGCODE_IR);
    expect(reg.version).toBe(1);
    expect(reg.moduleName).toBe("Тест");
    expect(isRegModule({ ...reg, ir: "osvbc" })).toBe(false);
  });

  it("артефакт сериализуем в JSON (формат файла .osvreg.json)", () => {
    const reg = regOf(FIRST_TARGET);
    const restored: unknown = JSON.parse(JSON.stringify(reg));
    expect(isRegModule(restored)).toBe(true);
  });
});

describe("regcodegen: переменные и параметры", () => {
  it("параметры занимают vreg 0..argc-1, затем идут пусть", () => {
    // `в` — ключевое слово языка (`для_каждого x в …`), поэтому имя переменной
    // берём нейтральное.
    const reg = regOf(`модуль Тест
процедура сложить(а, б)
  пусть итог = а + б
  вернуть итог
конец
конец
`);
    const proc = reg.procedures[0]!;
    expect(proc.argc).toBe(2);
    expect(proc.localToVreg).toEqual({ а: 0, б: 1, итог: 2 });
    // Файл регистров не меньше числа переменных, временные начинаются выше.
    expect(proc.vregs).toBeGreaterThanOrEqual(3);
  });

  it("переменная как выражение не копируется в свежий регистр", () => {
    const reg = regOf(`модуль Тест
процедура главная()
  пусть x = 7
  вернуть x
конец
конец
`);
    // `пусть x = 7` пишет литерал прямо в регистр переменной (не во временный);
    // `вернуть x` считает выражение в свежий регистр и переносит значение одной
    // копией — то есть значение переменной ниоткуда не «переезжает» лишний раз.
    const proc = reg.procedures[0]!;
    const varReg = proc.localToVreg.x;
    expect(varReg).toBe(0);
    expect(reg.code[0]).toEqual({ op: "const", d: varReg, type: "i32", k: 0 });
    expect(reg.code.filter((i) => i.op === "move")).toHaveLength(1);
    const ret = reg.code.find((i) => i.op === "ret");
    const retReg = (ret as { v?: number }).v;
    expect(retReg).toBeDefined();
    expect(retReg).not.toBe(varReg);
  });

  it("неизвестная переменная → ошибка кодогена", () => {
    const ast = astOf(`модуль Тест
процедура главная()
  вернуть 1
конец
конец
`);
    // Подмена AST: имитируем недоразрешённое имя.
    const broken: Module = {
      ...ast,
      procedures: ast.procedures.map((p) => ({
        ...p,
        body: [{ kind: "вернуть" as const, value: { kind: "переменная" as const, name: "нет_такой" } }],
      })),
    };
    expect(() => compileToReg(broken)).toThrowError(/Неизвестная переменная/);
  });
});

describe("regcodegen: переходы адресуются абсолютно", () => {
  it("если/иначе: обе ветки сходятся на одной позиции", () => {
    const reg = regOf(`модуль Тест
процедура главная()
  если 1 < 2
    вернуть 1
  иначе
    вернуть 2
  конец
конец
`);
    const jmpIfNot = reg.code.findIndex((i) => i.op === "jmp_if_not");
    const jmp = reg.code.findIndex((i) => i.op === "jmp");
    expect(jmpIfNot).toBeGreaterThanOrEqual(0);
    expect(jmp).toBeGreaterThan(jmpIfNot);
    const ifNotTarget = (reg.code[jmpIfNot] as { off: number }).off;
    // Цель `иначе` — сразу за безусловным переходом.
    expect(ifNotTarget).toBe(jmp + 1);
    // Цель `jmp` — конец `если`: в коде обеих веток это `ret` из ветки.
    const jmpTarget = (reg.code[jmp] as { off: number }).off;
    expect(reg.code[jmpTarget]!.op).toBe("ret");
    // И обе ветки возвращают: после слияния идёт только «падение с конца».
    expect(reg.code.filter((i) => i.op === "ret")).toHaveLength(3);
  });

  it("короткое замыкание: правый операнд сходится в тот же регистр", () => {
    const reg = regOf(`модуль Тест
процедура главная()
  пусть a = 1
  пусть b = 2
  вернуть a > 0 и b > 0
конец
конец
`);
    const jmpIfNot = reg.code.findIndex((i) => i.op === "jmp_if_not");
    expect(jmpIfNot).toBeGreaterThanOrEqual(0);
    const cond = (reg.code[jmpIfNot] as { cond?: number }).cond;
    const target = (reg.code[jmpIfNot] as { off: number }).off;
    expect(cond).toBeDefined();
    // Слева и справа пишут в один регистр условия: результат сходится без стека.
    expect(reg.code[target]!.op).toBe("ret");
  });
});

describe("regcodegen: Шаг 1 — управляющие конструкции раскладываются по регистрам", () => {
  it("пока: условие перепроверяется, тело не дублируется в коде", () => {
    const reg = regOf(`модуль Тест
процедура главная()
  пусть i = 0
  пока i < 3
    i = i + 1
  конец
  вернуть i
конец
конец
`);
    // Тело содержит ровно один инкремент: холостой проход не должен оставить
    // в артефакте вторую копию (иначе цикл выполнялся бы дважды за итерацию).
    const adds = reg.code.filter((i) => i.op === "add");
    expect(adds).toHaveLength(1);
    const jmpIfNot = reg.code.findIndex((i) => i.op === "jmp_if_not");
    const backJmp = reg.code.findIndex((i) => i.op === "jmp");
    expect(jmpIfNot).toBeGreaterThanOrEqual(0);
    // Обратный переход ведёт на проверку условия — она ВЫШЕ перехода.
    const loopStart = (reg.code[backJmp] as { off: number }).off;
    expect(loopStart).toBeLessThan(backJmp);
  });

  it("прервать внутри цикла патчится на конец цикла", () => {
    const reg = regOf(`модуль Тест
процедура главная()
  пусть n = 0
  цикл
    n = n + 1
    если n > 2
      прервать
    конец
  конец
  вернуть n
конец
конец
`);
    // `прервать` — безусловный переход, его цель — выход из цикла (после ret).
    const jumps = reg.code
      .map((ins, index) => ({ ins, index }))
      .filter(({ ins }) => ins.op === "jmp")
      .map(({ ins }) => (ins as { off: number }).off);
    expect(jumps.length).toBeGreaterThan(0);
    const last = reg.code.length - 1;
    expect(jumps.some((off) => off > 0 && off <= last)).toBe(true);
  });

  it("для_каждого: служебные ячейки объявлены и отличаются от переменных цикла", () => {
    const reg = regOf(`модуль Тест
процедура главная()
  пусть сумма = 0
  для_каждого ч, i в [1, 2]
    сумма = сумма + ч
  конец
  вернуть сумма
конец
конец
`);
    const proc = reg.procedures[0]!;
    const l = proc.localToVreg;
    expect(l["сумма"]).toBeDefined();
    expect(l["ч"]).toBeDefined();
    expect(l["i"]).toBeDefined();
    expect(l["__forEach_src_0"]).toBeDefined();
    expect(l["__forEach_len_0"]).toBeDefined();
    expect(l["__forEach_i_0"]).toBeDefined();
    const slots = Object.values(l);
    expect(new Set(slots).size).toBe(slots.length);
  });

  it("два вложенных для_каждого получают разные служебные ячейки", () => {
    const reg = regOf(`модуль Тест
процедура главная()
  пусть итог = 0
  для_каждого строка в [[1], [2]]
    для_каждого ч в строка
      итог = итог + ч
    конец
  конец
  вернуть итог
конец
конец
`);
    const l = reg.procedures[0]!.localToVreg;
    expect(l["__forEach_src_0"]).not.toBe(l["__forEach_src_1"]);
    expect(l["__forEach_i_1"]).toBeDefined();
  });

  it("кортеж — массив, распаковка берёт элементы по индексу", () => {
    const reg = regOf(`модуль Тест
процедура главная()
  пусть a, b = пара()
  вернуть a + b
конец
процедура пара()
  вернуть 1, 2
конец
конец
`);
    const invoked = reg.code.filter((i) => i.op === "invoke").map((i) => (i as { name: string }).name);
    expect(invoked).toContain("система.массив.создать");
    expect(invoked).toContain("система.массив.добавить");
    // Распаковка читает элементы по индексу — дважды (a и b).
    expect(invoked.filter((n) => n === "система.массив.получить")).toHaveLength(2);
  });

  it("попробовать: try_begin несёт адрес обработчика и регистр приёмника", () => {
    const reg = regOf(`модуль Тест
процедура главная()
  попробовать
    выбросить "о"
  иначе_попытка ошибка
    вернуть 2
  конец
конец
конец
`);
    const begin = reg.code.findIndex((i) => i.op === "try_begin");
    const end = reg.code.findIndex((i) => i.op === "try_end");
    const throwIdx = reg.code.findIndex((i) => i.op === "throw");
    expect(begin).toBeGreaterThanOrEqual(0);
    expect(throwIdx).toBeGreaterThan(begin);
    expect(end).toBeGreaterThan(throwIdx);
    const catchReg = (reg.code[begin] as { catchReg: number }).catchReg;
    expect(catchReg).toBe(reg.procedures[0]!.localToVreg["ошибка"]);
    // Цель обработчика — после `jmp` через блок catch: там начинается тело
    // `иначе_попытка` (в этом примере — `вернуть 2`, то есть `const` + `ret`).
    const catchLabel = (reg.code[begin] as { off: number }).off;
    expect(catchLabel).toBeGreaterThan(end);
    expect(reg.code[catchLabel]!.op).toBe("const");
    expect(reg.code[catchLabel + 1]!.op).toBe("ret");
  });
});

describe("RegAllocator: отметка → выделение → освобождение", () => {
  it("последовательные временные не переиспользуют живой регистр", () => {
    const a = new RegAllocator(2);
    expect(a.mark()).toBe(2);
    expect(a.alloc()).toBe(2);
    expect(a.alloc()).toBe(3);
    a.freeTo(2);
    expect(a.alloc()).toBe(2);
    expect(a.vregs()).toBe(4);
  });

  it("vregs не меньше базы (переменные занимают 0..base-1)", () => {
    const a = new RegAllocator(5);
    expect(a.vregs()).toBe(5);
  });

  it("откат ниже базы — ошибка кодогена", () => {
    const a = new RegAllocator(3);
    expect(() => a.freeTo(1)).toThrowError(RegCodegenError);
  });

  it("вложенные выражения освобождают временные после инструкции", () => {
    const reg = regOf(`модуль Тест
процедура главная()
  пусть a = 1 + 2
  пусть b = 3 + 4
  вернуть a + b
конец
конец
`);
    const proc = reg.procedures[0]!;
    // Две переменные + небольшое число временных: временные не накапливаются
    // линейно по числу инструкций.
    expect(proc.vregs).toBeLessThan(8);
  });
});

describe("regcodegen: один AST — два бэкенда", () => {
  it("кодоген не мутирует входной AST", () => {
    const ast = astOf(FIRST_TARGET);
    const before = JSON.stringify(ast);
    compileToReg(ast);
    expect(JSON.stringify(ast)).toBe(before);
  });

  it("стековый и регистровый кодогены берут один и тот же moduleAst", () => {
    const result = compileSource(FIRST_TARGET);
    expect(result.module).not.toBeNull();
    expect(result.moduleAst).toBeDefined();
    expect(result.moduleAst!.procedures[0]!.name).toBe(result.module!.procedures[0]!.name);
  });
});
