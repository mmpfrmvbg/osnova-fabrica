/**
 * Регрессия по операции деления по модулю (%) в VM: Issues #2, #4.
 */
import { describe, it, expect } from "vitest";
import { compileSource } from "./compiler";
import { VM, InterpreterError } from "./vm";

async function runProcIdx(module: NonNullable<ReturnType<typeof compileSource>["module"]>, index = 0) {
  const vm = new VM(module);
  return vm.runProcedure(index, []);
}

describe("VM: оператор % (rem)", () => {
  it("положительные операнды", async () => {
    const src = `модуль т
процедура р()
  вернуть 10 % 3
конец
конец`;
    const r = compileSource(src);
    expect(r.compilerSuccess).toBe(true);
    expect(await runProcIdx(r.module!)).toBe(1);
  });

  it("приоритет: % перед сложением", async () => {
    const src = `модуль т
процедура р()
  вернуть 1 + 10 % 3
конец
конец`;
    const r = compileSource(src);
    expect(r.compilerSuccess).toBe(true);
    expect(await runProcIdx(r.module!)).toBe(2);
  });

  it("левоассоциативность: a % b % c как в JavaScript", async () => {
    const src = `модуль т
процедура р()
  вернуть 17 % 5 % 3
конец
конец`;
    const r = compileSource(src);
    expect(r.compilerSuccess).toBe(true);
    expect(await runProcIdx(r.module!)).toBe((17 % 5) % 3);
  });

  it("отрицательный делимое — семантика как в JavaScript", async () => {
    const src = `модуль т
процедура р()
  вернуть -10 % 3
конец
конец`;
    const r = compileSource(src);
    expect(r.compilerSuccess).toBe(true);
    expect(await runProcIdx(r.module!)).toBe(-10 % 3);
  });

  it("отрицательный делитель — семантика как в JavaScript", async () => {
    const src = `модуль т
процедура р()
  вернуть 10 % -3
конец
конец`;
    const r = compileSource(src);
    expect(r.compilerSuccess).toBe(true);
    expect(await runProcIdx(r.module!)).toBe(10 % -3);
  });

  it("нуль в делимом", async () => {
    const src = `модуль т
процедура р()
  вернуть 0 % 7
конец
конец`;
    const r = compileSource(src);
    expect(r.compilerSuccess).toBe(true);
    expect(await runProcIdx(r.module!)).toBe(0);
  });

  it("деление на ноль — InterpreterError (rem)", async () => {
    const src = `модуль т
процедура р()
  вернуть 5 % 0
конец
конец`;
    const r = compileSource(src);
    expect(r.compilerSuccess).toBe(true);
    await expect(runProcIdx(r.module!)).rejects.toMatchObject({
      name: "InterpreterError",
      op: "rem",
    });
  });

  it("сценарий чётности i % 2 == 0", async () => {
    const src = `модуль т
процедура р()
  пусть i = 4
  вернуть i % 2 == 0
конец
конец`;
    const r = compileSource(src);
    expect(r.compilerSuccess).toBe(true);
    expect(await runProcIdx(r.module!)).toBe(true);
  });

  /** Явные регрессии по спецификации ATM (5 и ±2) — семантика как в JavaScript. */
  it.each([
    { expr: "5 % 2", expected: 5 % 2 },
    { expr: "-5 % 2", expected: -5 % 2 },
    { expr: "5 % -2", expected: 5 % -2 },
    { expr: "-5 % -2", expected: -5 % -2 },
  ] as const)("комбинации 5 и ±2: %s → %s", async ({ expr, expected }) => {
    const src = `модуль т
процедура р()
  вернуть ${expr}
конец
конец`;
    const r = compileSource(src);
    expect(r.compilerSuccess).toBe(true);
    expect(await runProcIdx(r.module!)).toBe(expected);
  });

  it("большие целые и граница Number.MAX_SAFE_INTEGER", async () => {
    const max = Number.MAX_SAFE_INTEGER;
    const src = `модуль т
процедура р()
  вернуть ${max} % 10 == ${max % 10} и 1000000007 % 97 == ${1000000007 % 97}
конец
конец`;
    const r = compileSource(src);
    expect(r.compilerSuccess).toBe(true);
    expect(await runProcIdx(r.module!)).toBe(true);
  });
});

describe("VM: система.математика.остаток и % согласованы для обычных чисел", () => {
  it("10 % 3 совпадает с остаток(10,3)", async () => {
    const src = `модуль т
процедура р()
  вернуть система.математика.остаток(10, 3) == 10 % 3
конец
конец`;
    const r = compileSource(src);
    expect(r.compilerSuccess).toBe(true);
    expect(await runProcIdx(r.module!)).toBe(true);
  });
});
