/**
 * Интеграционные тесты OsVbcVM: полный цикл execute → возврат, цепочки вызовов,
 * исключения (throw / try), пользовательский invoke (native callbacks).
 */

import { describe, it, expect } from "vitest";
import { compileSource } from "../compiler/compiler";
import * as runtime from "./index";
import {
  OsVbcVM,
  applyPipelineSpecToVm,
  buildPipelineVmGlobals,
  createDefaultInvokeHandler,
  createPipelineInvokeHandlerForVm,
  safeExecutePipelineVm,
} from "./vm";
import type { StackValue, InvokeHandler } from "./vm";
import { InterpreterError } from "./interpreter";
import type { OsVbcModule, RawInstruction } from "./vm/bytecode";
import { QUALITY_PARTIAL, QUALITY_PASS } from "../pipeline/thresholds";
import { getInvokeArgCount } from "./vm/invokeRegistry";

function ri(op: RawInstruction["op"], rest: Record<string, unknown> = {}): RawInstruction {
  return { op, ...rest } as RawInstruction;
}

describe("OsVbcVM integration", () => {
  it("полный цикл: compileSource → OsVbcVM.execute возвращает литерал", async () => {
    const src = `
модуль ИнтегКомпил

процедура главная()
  вернуть 99
конец
`.trim();
    const compiled = compileSource(src);
    expect(compiled.compilerSuccess).toBe(true);
    expect(compiled.module).not.toBeNull();
    const vm = new OsVbcVM(compiled.module!, { maxSteps: 2000 });
    expect(await vm.execute()).toBe(99);
    expect(vm.getReturnValue()).toBe(99);
  });

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
    await expect(vm.execute({ timeoutMs: 30 })).rejects.toThrow(runtime.TimeoutError);
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

/**
 * Регрессия vm-crash на % (Issues #2, #4), пороги G3 / qualityScore и syscall пайплайна.
 * Реализация rem — в interpreter (notouch vm.ts); здесь полный путь OsVbcVM.execute.
 */
describe("OsVbcVM: vm-crash % (rem), safeExecute и контракт пайплайна", () => {
  it("rem: 10 % 3 → 1 (стек: делимое, затем делитель)", async () => {
    const m: OsVbcModule = {
      version: 1,
      moduleName: "RemДеление",
      constants: [10, 3],
      procedures: [{ name: "главная", codeOffset: 0, argc: 0, localsCount: 0 }],
      code: [
        ri("const", { type: "i32", k: 0 }),
        ri("const", { type: "i32", k: 1 }),
        ri("rem"),
        ri("ret"),
      ],
    };
    const vm = new OsVbcVM(m, { maxSteps: 1000 });
    expect(await vm.execute()).toBe(1);
    expect(vm.getReturnValue()).toBe(1);
  });

  it("rem: делитель 0 → InterpreterError Remainder by zero (op, pc)", async () => {
    const m: OsVbcModule = {
      version: 1,
      moduleName: "RemНоль",
      constants: [5, 0],
      procedures: [{ name: "главная", codeOffset: 0, argc: 0, localsCount: 0 }],
      code: [
        ri("const", { type: "i32", k: 0 }),
        ri("const", { type: "i32", k: 1 }),
        ri("rem"),
        ri("ret"),
      ],
    };
    const vm = new OsVbcVM(m, { maxSteps: 1000 });
    await expect(vm.execute()).rejects.toMatchObject({
      name: "InterpreterError",
      message: "Remainder by zero",
      op: "rem",
      pc: 2,
    });
    expect(vm.getReturnValue()).toBeUndefined();
  });

  it("rem by zero: onExecutionLog start → error; safeExecutePipelineVm ok:false", async () => {
    const phases: string[] = [];
    const m: OsVbcModule = {
      version: 1,
      moduleName: "RemЛог",
      constants: [1, 0],
      procedures: [{ name: "главная", codeOffset: 0, argc: 0, localsCount: 0 }],
      code: [
        ri("const", { type: "i32", k: 0 }),
        ri("const", { type: "i32", k: 1 }),
        ri("rem"),
        ri("ret"),
      ],
    };
    const vm = new OsVbcVM(m, {
      maxSteps: 1000,
      onExecutionLog: (e) => phases.push(e.phase),
    });
    const wrapped = await safeExecutePipelineVm(vm);
    expect(phases).toEqual(["start", "error"]);
    expect(wrapped.ok).toBe(false);
    if (!wrapped.ok) {
      expect(wrapped.error).toMatch(/Remainder by zero/);
    }
  });

  it("try_begin ловит только throw: Remainder by zero из rem не перехватывается байткодом", async () => {
    const m: OsVbcModule = {
      version: 1,
      moduleName: "RemНеПоймать",
      constants: [5, 0, 7],
      procedures: [{ name: "главная", codeOffset: 0, argc: 0, localsCount: 0 }],
      code: [
        ri("try_begin", { off: 5 }),
        ri("const", { type: "i32", k: 0 }),
        ri("const", { type: "i32", k: 1 }),
        ri("rem"),
        ri("try_end"),
        ri("const", { type: "i32", k: 2 }),
        ri("ret"),
      ],
    };
    const vm = new OsVbcVM(m, { maxSteps: 1000 });
    await expect(vm.execute()).rejects.toMatchObject({
      name: "InterpreterError",
      message: "Remainder by zero",
      op: "rem",
    });
  });

  it("восстановление на уровне хоста: после rem-crash новый OsVbcVM выполняет валидный %", async () => {
    const crashMod: OsVbcModule = {
      version: 1,
      moduleName: "RemСбой",
      constants: [3, 0],
      procedures: [{ name: "главная", codeOffset: 0, argc: 0, localsCount: 0 }],
      code: [
        ri("const", { type: "i32", k: 0 }),
        ri("const", { type: "i32", k: 1 }),
        ri("rem"),
        ri("ret"),
      ],
    };
    const okMod: OsVbcModule = {
      version: 1,
      moduleName: "RemОк",
      constants: [10, 3],
      procedures: [{ name: "главная", codeOffset: 0, argc: 0, localsCount: 0 }],
      code: [
        ri("const", { type: "i32", k: 0 }),
        ri("const", { type: "i32", k: 1 }),
        ri("rem"),
        ri("ret"),
      ],
    };
    await expect(new OsVbcVM(crashMod, { maxSteps: 1000 }).execute()).rejects.toMatchObject({
      message: "Remainder by zero",
    });
    expect(await new OsVbcVM(okMod, { maxSteps: 1000 }).execute()).toBe(1);
  });

  it("тот же OsVbcVM: после rem-crash следующий execute() не наследует грязные frames", async () => {
    const crashThenOk: OsVbcModule = {
      version: 1,
      moduleName: "RemПовтор",
      constants: [10, 3, 0],
      procedures: [
        { name: "сбой", codeOffset: 0, argc: 0, localsCount: 0 },
        { name: "главная", codeOffset: 4, argc: 0, localsCount: 0 },
      ],
      code: [
        ri("const", { type: "i32", k: 0 }),
        ri("const", { type: "i32", k: 2 }),
        ri("rem"),
        ri("ret"),
        ri("const", { type: "i32", k: 0 }),
        ri("const", { type: "i32", k: 1 }),
        ri("rem"),
        ri("ret"),
      ],
    };
    const vm = new OsVbcVM(crashThenOk, { maxSteps: 1000 });
    await expect(vm.execute({ procedure: "сбой" })).rejects.toMatchObject({ message: "Remainder by zero" });
    expect(await vm.execute()).toBe(1);
    expect(vm.getReturnValue()).toBe(1);
  });

  it("пороги G3: QUALITY_PARTIAL < QUALITY_PASS (thresholds.ts ↔ gates)", () => {
    expect(QUALITY_PASS).toBe(0.7);
    expect(QUALITY_PARTIAL).toBe(0.5);
    expect(QUALITY_PARTIAL).toBeLessThan(QUALITY_PASS);
  });

  it("invokeRegistry: система.пайплайн.* с арностью 0 согласованы с createPipelineInvokeHandlerForVm", () => {
    const pipelineInvokes = [
      "система.пайплайн.ид_спецификации",
      "система.пайплайн.главный_модуль",
      "система.пайплайн.ожидаемый_возврат",
    ] as const;
    for (const name of pipelineInvokes) {
      expect(getInvokeArgCount(name)).toBe(0);
    }
    const inner: OsVbcVM = new OsVbcVM(
      {
        version: 1,
        moduleName: "ПайплайнСискалл",
        constants: [],
        procedures: [{ name: "главная", codeOffset: 0, argc: 0, localsCount: 0 }],
        code: [ri("ret")],
      },
      { maxSteps: 100 },
    );
    applyPipelineSpecToVm(inner, {
      specId: "reg",
      modules: [],
      mainModule: "M",
      types: [],
      procedures: [],
      syscalls: [],
      conventions: {},
    });
    const h = createPipelineInvokeHandlerForVm(inner);
    expect(h("система.пайплайн.ид_спецификации", [])).toBe("reg");
    expect(h("система.пайплайн.главный_модуль", [])).toBe("M");
    expect(h("система.пайплайн.ожидаемый_возврат", [])).toBe(null);
  });
});
