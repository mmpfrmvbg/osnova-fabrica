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
