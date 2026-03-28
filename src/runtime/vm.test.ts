/**
 * Интеграционные тесты OsVbcVM: полный цикл execute → возврат, цепочки вызовов,
 * исключения (throw / try), пользовательский invoke (native callbacks).
 */

import { describe, it, expect } from "vitest";
import { OsVbcVM, createDefaultInvokeHandler } from "./vm";
import type { StackValue, InvokeHandler } from "./vm";
import { InterpreterError } from "./interpreter";
import type { OsVbcModule, RawInstruction } from "./vm/bytecode";

function ri(op: RawInstruction["op"], rest: Record<string, unknown> = {}): RawInstruction {
  return { op, ...rest } as RawInstruction;
}

describe("OsVbcVM integration", () => {
  it("выполняет простой модуль и возвращает значение с главная", async () => {
    const m: OsVbcModule = {
      version: 1,
      moduleName: "ИнтегПростой",
      constants: [42],
      procedures: [{ name: "главная", codeOffset: 0, argc: 0, localsCount: 1 }],
      code: [ri("const", { type: "i32", k: 0 }), ri("ret")],
    };
    const vm = new OsVbcVM(m, { maxSteps: 1000 });
    const out = await vm.execute();
    expect(out).toBe(42);
    expect(vm.getReturnValue()).toBe(42);
  });

  it("последовательно вызывает несколько процедур и комбинирует результат", async () => {
    const m: OsVbcModule = {
      version: 1,
      moduleName: "ИнтегЦепочка",
      constants: [10, 20],
      procedures: [
        { name: "главная", codeOffset: 0, argc: 0, localsCount: 0 },
        { name: "десять", codeOffset: 4, argc: 0, localsCount: 0 },
        { name: "двадцать", codeOffset: 6, argc: 0, localsCount: 0 },
      ],
      code: [
        ri("call", { fi: 1 }),
        ri("call", { fi: 2 }),
        ri("add"),
        ri("ret"),
        ri("const", { type: "i32", k: 0 }),
        ri("ret"),
        ri("const", { type: "i32", k: 1 }),
        ri("ret"),
      ],
    };
    const vm = new OsVbcVM(m, { maxSteps: 1000 });
    expect(await vm.execute()).toBe(30);
  });

  it("необработанное исключение на уровне VM → InterpreterError", async () => {
    const m: OsVbcModule = {
      version: 1,
      moduleName: "ИнтегБросок",
      constants: ["fail"],
      procedures: [{ name: "главная", codeOffset: 0, argc: 0, localsCount: 0 }],
      code: [ri("const", { type: "str", k: 0 }), ri("throw")],
    };
    const vm = new OsVbcVM(m, { maxSteps: 1000 });
    await expect(vm.execute()).rejects.toThrow(InterpreterError);
  });

  it("обрабатывает throw внутри try_begin / catch offset", async () => {
    const m: OsVbcModule = {
      version: 1,
      moduleName: "ИнтегПоймать",
      constants: ["err", "ok"],
      procedures: [{ name: "главная", codeOffset: 0, argc: 0, localsCount: 0 }],
      code: [
        ri("try_begin", { off: 4 }),
        ri("const", { type: "str", k: 0 }),
        ri("throw"),
        ri("try_end"),
        ri("pop"),
        ri("const", { type: "str", k: 1 }),
        ri("ret"),
      ],
    };
    const vm = new OsVbcVM(m, { maxSteps: 1000 });
    expect(await vm.execute()).toBe("ok");
  });

  it("native invoke: пользовательский callback для известного имени", async () => {
    const nativeCalls: StackValue[][] = [];
    const base = createDefaultInvokeHandler();
    const invoke: InvokeHandler = async (name, args) => {
      if (name === "система.строка.объединить") {
        nativeCalls.push([...args]);
        return `native:${String(args[0])}|${String(args[1])}`;
      }
      const r = base(name, args);
      return r as StackValue;
    };

    const m: OsVbcModule = {
      version: 1,
      moduleName: "ИнтегНатив",
      constants: ["a", "b"],
      procedures: [{ name: "главная", codeOffset: 0, argc: 0, localsCount: 0 }],
      code: [
        ri("const", { type: "str", k: 0 }),
        ri("const", { type: "str", k: 1 }),
        ri("invoke", { name: "система.строка.объединить" }),
        ri("ret"),
      ],
    };
    const vm = new OsVbcVM(m, { invoke, maxSteps: 1000 });
    expect(await vm.execute()).toBe("native:a|b");
    expect(nativeCalls).toEqual([["a", "b"]]);
  });
});
