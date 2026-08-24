/**
 * Перечни (тип Имя = a | b) и живая проверка типов полей.
 */
import { describe, expect, it } from "vitest";
import { compileSource, Compiler } from "./compiler";

describe("перечень вариантов", () => {
  it("тип Масть = пики | черви компилируется, литерал — строка", async () => {
    const src = `
модуль Т
тип Масть = пики | черви | буби | трефы
процедура главная()
  пусть м: Масть = Масть.пики
  если м == Масть.пики
    вернуть 1
  конец
  вернуть 0
конец
конец`.trim();
    const cr = compileSource(src);
    expect(cr.parserErrors).toHaveLength(0);
    expect(cr.compilerErrors).toEqual([]);
    expect(cr.compilerSuccess).toBe(true);
    expect(await new Compiler().execute(src, { procedureName: "главная" })).toBe(1);
  });

  it("запись + перечень: Карта", async () => {
    const src = `
модуль Т
тип Масть = пики | черви
тип Дост = шесть | туз
тип Карта { масть: Масть, дост: Дост }
процедура главная()
  пусть к: Карта = { масть: Масть.пики, дост: Дост.шесть }
  если к.масть == Масть.пики
    вернуть 1
  конец
  вернуть 0
конец
конец`.trim();
    const cr = compileSource(src);
    expect(cr.compilerErrors).toEqual([]);
    expect(cr.compilerSuccess).toBe(true);
    expect(await new Compiler().execute(src, { procedureName: "главная" })).toBe(1);
  });
});

describe("проверка типов полей", () => {
  it("неизвестное поле у типизированной записи — ошибка", () => {
    const src = `
модуль Т
тип Мир { счет: Число }
процедура главная()
  пусть мир: Мир = { счет: 0 }
  вернуть мир.масть
конец
конец`.trim();
    const cr = compileSource(src);
    expect(cr.compilerSuccess).toBe(false);
    expect(cr.compilerErrors.some((e) => /Неизвестное поле: масть/.test(e.message))).toBe(true);
  });

  it("запись в Число — ошибка", () => {
    const src = `
модуль Т
процедура главная()
  пусть x: Число = "нет"
  вернуть x
конец
конец`.trim();
    const cr = compileSource(src);
    expect(cr.compilerSuccess).toBe(false);
    expect(cr.compilerErrors.some((e) => /Несовпадение типа/.test(e.message))).toBe(true);
  });

  it("присвоение в поле неверного типа — ошибка", () => {
    const src = `
модуль Т
тип Мир { счет: Число }
процедура главная()
  пусть мир: Мир = { счет: 0 }
  мир.счет = "строка"
  вернуть мир.счет
конец
конец`.trim();
    const cr = compileSource(src);
    expect(cr.compilerSuccess).toBe(false);
    expect(cr.compilerErrors.some((e) => /Несовпадение типа/.test(e.message))).toBe(true);
  });

  it("параметр с типом проверяет аргумент", () => {
    const src = `
модуль Т
тип Масть = пики | черви
процедура взять(м: Масть)
  вернуть м
конец
процедура главная()
  вернуть взять(1)
конец
конец`.trim();
    const cr = compileSource(src);
    expect(cr.compilerSuccess).toBe(false);
    expect(cr.compilerErrors.some((e) => /Несовпадение типа/.test(e.message))).toBe(true);
  });

  it("неаннотированное остаётся дырявым", () => {
    const src = `
модуль Т
процедура главная()
  пусть x = { a: 1 }
  вернуть x.b
конец
конец`.trim();
    const cr = compileSource(src);
    expect(cr.compilerSuccess).toBe(true);
  });
});
