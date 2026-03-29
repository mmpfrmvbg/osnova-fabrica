/**
 * Интеграционные тесты OsVbcVM: полный цикл execute → возврат, цепочки вызовов,
 * исключения (throw / try), пользовательский invoke (native callbacks).
 */

import { describe, it, expect } from "vitest";
import {
  OsVbcVM,
  applyPipelineSpecToVm,
  buildPipelineVmGlobals,
  createDefaultInvokeHandler,
  createPipelineInvokeHandlerForVm,
} from "./vm";
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

  it("createDefaultInvokeHandler: только системный handler — строка.объединить и return path", async () => {
    const m: OsVbcModule = {
      version: 1,
      moduleName: "ДефолтИнвок",
      constants: ["x", "y"],
      procedures: [{ name: "главная", codeOffset: 0, argc: 0, localsCount: 0 }],
      code: [
        ri("const", { type: "str", k: 0 }),
        ri("const", { type: "str", k: 1 }),
        ri("invoke", { name: "система.строка.объединить" }),
        ri("ret"),
      ],
    };
    const vm = new OsVbcVM(m, { invoke: createDefaultInvokeHandler(), maxSteps: 1000 });
    expect(await vm.execute()).toBe("xy");
    expect(vm.getReturnValue()).toBe("xy");
  });

  it("createDefaultInvokeHandler: неизвестный invoke → InterpreterError до вызова handler", async () => {
    const m: OsVbcModule = {
      version: 1,
      moduleName: "НеизвИнвок",
      constants: [],
      procedures: [{ name: "главная", codeOffset: 0, argc: 0, localsCount: 0 }],
      code: [ri("invoke", { name: "система.__no_such__.invoke" }), ri("ret")],
    };
    const vm = new OsVbcVM(m, { invoke: createDefaultInvokeHandler(), maxSteps: 1000 });
    await expect(vm.execute()).rejects.toMatchObject({
      name: "InterpreterError",
      message: expect.stringMatching(/Unknown invoke/),
    });
    expect(vm.getReturnValue()).toBeUndefined();
  });

  it("maxSteps: бесконечный jmp превышает лимит → InterpreterError", async () => {
    const m: OsVbcModule = {
      version: 1,
      moduleName: "МаксШаги",
      constants: [],
      procedures: [{ name: "главная", codeOffset: 0, argc: 0, localsCount: 0 }],
      code: [ri("jmp", { off: 0 })],
    };
    const vm = new OsVbcVM(m, { maxSteps: 50 });
    await expect(vm.execute()).rejects.toMatchObject({
      name: "InterpreterError",
      message: expect.stringMatching(/Max steps exceeded/),
    });
    expect(vm.getReturnValue()).toBeUndefined();
  });

  it("pipeline: buildPipelineVmGlobals + createPipelineInvokeHandlerForVm (без bytecode invoke)", () => {
    const m: OsVbcModule = {
      version: 1,
      moduleName: "ПайплайнТест",
      constants: [],
      procedures: [{ name: "главная", codeOffset: 0, argc: 0, localsCount: 0 }],
      code: [ri("ret")],
    };
    const vm = new OsVbcVM(m, { maxSteps: 1000 });
    applyPipelineSpecToVm(vm, {
      specId: "spec-x",
      modules: [{ name: "M", description: "", isMain: true }],
      mainModule: "M",
      types: [],
      procedures: [],
      syscalls: [],
      conventions: {},
    });
    const h = createPipelineInvokeHandlerForVm(vm);
    expect(h("система.пайплайн.ид_спецификации", [])).toBe("spec-x");
    expect(h("система.пайплайн.главный_модуль", [])).toBe("M");
    expect(buildPipelineVmGlobals({ specId: "a", mainModule: "M", modules: [], types: [], procedures: [], syscalls: [], conventions: {} })).toMatchObject({
      __osnova_pipeline_spec_id: "a",
      __osnova_pipeline_main_module: "M",
    });
  });

  it("timeoutMs: зависший invoke обрывается по wall-clock", async () => {
    const m: OsVbcModule = {
      version: 1,
      moduleName: "Таймаут",
      constants: [],
      procedures: [{ name: "главная", codeOffset: 0, argc: 0, localsCount: 0 }],
      code: [ri("const.null"), ri("invoke", { name: "система.лог.вывести" }), ri("ret")],
    };
    const invoke: InvokeHandler = () => new Promise(() => {});
    const vm = new OsVbcVM(m, { invoke, maxSteps: 1000 });
    await expect(vm.execute({ timeoutMs: 30 })).rejects.toThrow(InterpreterError);
    expect(vm.getReturnValue()).toBeUndefined();
  });

  it("onExecutionLog: старт/успех; при ошибке — error и сброс getReturnValue", async () => {
    const events: { phase: string }[] = [];
    const m: OsVbcModule = {
      version: 1,
      moduleName: "Лог",
      constants: ["x"],
      procedures: [{ name: "главная", codeOffset: 0, argc: 0, localsCount: 0 }],
      code: [ri("const", { type: "str", k: 0 }), ri("throw")],
    };
    const vm = new OsVbcVM(m, {
      maxSteps: 1000,
      onExecutionLog: (e) => events.push({ phase: e.phase }),
    });
    await expect(vm.execute()).rejects.toThrow(InterpreterError);
    expect(events.map((x) => x.phase)).toEqual(["start", "error"]);
    expect(vm.getReturnValue()).toBeUndefined();
  });
});
