/**
 * Unit-тесты регистровой VM и формата {@link import("./regcode")}: то, что
 * проверяет сам интерпретатор на рукописном байткоде — без участия компилятора.
 * Совпадение со стековой VM проверяет оракул `src/oracle/parity.test.ts`.
 */

import { describe, it, expect } from "vitest";
import { RegVM, RegInterpreterError, runRegProgram } from "./reginterpreter";
import {
  isRegModule,
  REGCODE_IR,
  type RegInstruction,
  type RegModule,
} from "./regcode";

function mod(
  code: RegInstruction[],
  opts: { constants?: unknown[]; argc?: number; vregs?: number } = {},
): RegModule {
  return {
    ir: REGCODE_IR,
    version: 1,
    moduleName: "test",
    constants: opts.constants ?? [],
    procedures: [
      {
        name: "главная",
        codeOffset: 0,
        argc: opts.argc ?? 0,
        vregs: opts.vregs ?? 8,
        localToVreg: {},
      },
    ],
    code,
  };
}

async function run(
  code: RegInstruction[],
  opts: { constants?: unknown[]; args?: unknown[]; vregs?: number; invoke?: (n: string, a: unknown[]) => unknown } = {},
): Promise<unknown> {
  const vm = new RegVM(
    mod(code, {
      constants: opts.constants,
      vregs: opts.vregs,
      argc: opts.args?.length ?? 0,
    }),
    {
      maxSteps: 1000,
      invoke: (opts.invoke as never) ?? (() => null),
    },
  );
  return vm.runProcedure(0, (opts.args ?? []) as never);
}

const K = (d: number, k: number, type: "i32" | "str" = "i32"): RegInstruction => ({
  op: "const",
  d,
  type,
  k,
});

describe("regcode: форма артефакта", () => {
  it("валидатор принимает артефакт и отвергает чужой ir", () => {
    const m = mod([]);
    expect(isRegModule(m)).toBe(true);
    expect(isRegModule({ ...m, ir: "osnova-vbc" })).toBe(false);
    expect(isRegModule(null)).toBe(false);
    expect(isRegModule({})).toBe(false);
  });
});

describe("reginterpreter: арифметика трёхадресной формы", () => {
  it("d = a ∘ b читает регистры и пишет результат", async () => {
    const value = await run(
      [K(1, 0), K(2, 1), { op: "sub", d: 3, a: 1, b: 2 }, { op: "ret", v: 3 }],
      { constants: [10, 4] },
    );
    expect(value).toBe(6);
  });

  it("деление на ноль → RegInterpreterError", async () => {
    await expect(
      run([K(1, 0), K(2, 1), { op: "div", d: 3, a: 1, b: 2 }, { op: "ret", v: 3 }], {
        constants: [1, 0],
      }),
    ).rejects.toThrowError(/Division by zero/);
  });

  it("остаток на ноль → RegInterpreterError", async () => {
    await expect(
      run([K(1, 0), K(2, 1), { op: "rem", d: 3, a: 1, b: 2 }, { op: "ret", v: 3 }], {
        constants: [1, 0],
      }),
    ).rejects.toThrowError(/Remainder by zero/);
  });

  it("add со строкой конкатенирует через строковое представление", async () => {
    const value = await run(
      [K(1, 0), K(2, 1, "str"), { op: "add", d: 3, a: 1, b: 2 }, { op: "ret", v: 3 }],
      { constants: [5, "яблок"] },
    );
    expect(value).toBe("5яблок");
  });

  it("константа вне пула → ошибка", async () => {
    await expect(run([K(1, 9), { op: "ret", v: 1 }], { constants: [1] })).rejects.toThrowError(
      /Constant index out of range/,
    );
  });

  it("регистр вне диапазона → ошибка", async () => {
    await expect(run([{ op: "ret", v: 99 }], { vregs: 2 })).rejects.toThrowError(
      /Регистр вне диапазона/,
    );
  });

  it("неизвестный invoke → ошибка (как в стековой VM)", async () => {
    await expect(
      run([{ op: "invoke", d: 1, name: "система.нет.такого", args: [], argc: 0 }, { op: "ret", v: 1 }]),
    ).rejects.toThrowError(/Unknown invoke/);
  });

  it("неверная арность invoke → ошибка", async () => {
    await expect(
      run([
        K(1, 0),
        { op: "invoke", d: 2, name: "система.строка.длина", args: [1, 1], argc: 2 },
        { op: "ret", v: 2 },
      ], { constants: ["аб"] }),
    ).rejects.toThrowError(/ожидалось аргументов/);
  });
});

describe("reginterpreter: ветвления и вызовы", () => {
  it("jmp_if_not прыгает на абсолютный адрес при ложном условии", async () => {
    // r1 = 0; if (!r1) → 4; r1 = 1; ret r1
    const value = await run(
      [
        K(1, 0),
        { op: "jmp_if_not", off: 4, cond: 1 },
        K(2, 1),
        { op: "ret", v: 2 },
        { op: "ret", v: 1 },
      ],
      { constants: [0, 7] },
    );
    expect(value).toBe(0);
  });

  it("вызов процедуры переносит аргументы в регистры 0..argc-1", async () => {
    // Код: главная: r1=5; r2=6; call fi=1 (args r1,r2) → r3; ret r3
    //      двойка: r0+r1 → r2; ret r2
    const m: RegModule = {
      ir: REGCODE_IR,
      version: 1,
      moduleName: "test",
      constants: [5, 6],
      procedures: [
        { name: "главная", codeOffset: 0, argc: 0, vregs: 4, localToVreg: {} },
        { name: "двойка", codeOffset: 6, argc: 2, vregs: 4, localToVreg: {} },
      ],
      code: [
        K(1, 0),
        K(2, 1),
        { op: "call", d: 3, fi: 1, args: [1, 2], argc: 2 },
        { op: "ret", v: 3 },
        // недостижимо
        { op: "ret" },
        { op: "ret" },
        { op: "add", d: 2, a: 0, b: 1 },
        { op: "ret", v: 2 },
      ],
    };
    const vm = new RegVM(m, { maxSteps: 100 });
    expect(await vm.runProcedure(0, [])).toBe(11);
  });

  it("возврат из вложенного вызова кладёт значение в регистр вызывающего", async () => {
    const m: RegModule = {
      ir: REGCODE_IR,
      version: 1,
      moduleName: "test",
      constants: [41],
      procedures: [
        { name: "главная", codeOffset: 0, argc: 0, vregs: 4, localToVreg: {} },
        { name: "плюс_один", codeOffset: 4, argc: 0, vregs: 4, localToVreg: {} },
      ],
      code: [
        { op: "call", d: 1, fi: 1, args: [], argc: 0 },
        { op: "ret", v: 1 },
        { op: "ret" },
        { op: "ret" },
        K(2, 0),
        { op: "add", d: 3, a: 2, b: 2 },
        { op: "ret", v: 3 },
      ],
    };
    const vm = new RegVM(m, { maxSteps: 100 });
    expect(await vm.runProcedure(0, [])).toBe(82);
  });

  it("переполнение maxSteps → ошибка, а не зависание", async () => {
    await expect(
      run([{ op: "jmp", off: 0 }], { vregs: 1 }),
    ).rejects.toThrowError(/Max steps exceeded/);
  });
});

describe("reginterpreter: объекты", () => {
  it("obj.new + obj.set + obj.get читают и пишут по строковому ключу", async () => {
    const value = await run(
      [
        { op: "obj.new", d: 1 },
        K(2, 0, "str"),
        K(3, 1),
        { op: "obj.set", a: 1, key: 2, b: 3 },
        K(4, 2, "str"),
        { op: "obj.get", d: 5, a: 1, key: 4 },
        { op: "ret", v: 5 },
      ],
      { constants: ["поле", 42, "поле"] },
    );
    expect(value).toBe(42);
  });

  it("obj.get отсутствующего ключа → null", async () => {
    const value = await run(
      [
        { op: "obj.new", d: 1 },
        K(2, 0, "str"),
        { op: "obj.get", d: 3, a: 1, key: 2 },
        { op: "ret", v: 3 },
      ],
      { constants: ["нет"] },
    );
    expect(value).toBe(null);
  });

  it("объекты — ссылки: obj.set виден через другой регистр", async () => {
    const value = await run(
      [
        { op: "obj.new", d: 1 },
        { op: "move", d: 2, a: 1 },
        K(3, 0, "str"),
        K(4, 1),
        { op: "obj.set", a: 2, key: 3, b: 4 },
        { op: "obj.get", d: 5, a: 1, key: 3 },
        { op: "ret", v: 5 },
      ],
      { constants: ["к", 9] },
    );
    expect(value).toBe(9);
  });
});

describe("runRegProgram: точка входа", () => {
  it("находит главную и возвращает её значение", async () => {
    const value = await runRegProgram(
      mod([K(1, 0), { op: "ret", v: 1 }], { constants: [3] }),
    );
    expect(value).toBe(3);
  });

  it("может запустить процедуру по имени", async () => {
    const m: RegModule = {
      ir: REGCODE_IR,
      version: 1,
      moduleName: "test",
      constants: [8],
      procedures: [
        { name: "главная", codeOffset: 0, argc: 0, vregs: 2, localToVreg: {} },
        { name: "другая", codeOffset: 2, argc: 0, vregs: 2, localToVreg: {} },
      ],
      code: [{ op: "ret" }, { op: "ret" }, K(1, 0), { op: "ret", v: 1 }],
    };
    expect(await runRegProgram(m, {}, [], "другая")).toBe(8);
  });

  it("нет процедуры → ошибка", async () => {
    const m = mod([]);
    m.procedures = [];
    await expect(runRegProgram(m)).rejects.toThrowError(RegInterpreterError);
  });
});
