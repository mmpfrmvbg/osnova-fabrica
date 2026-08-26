/**
 * Табличные unit-тесты для VM — фиксация Stack Convention v0.1.
 * Запуск: npx vitest run
 */

import { describe, it, expect } from "vitest";
import * as fs from "fs/promises";
import * as path from "path";
import { VM, InterpreterError, runProgram } from "./interpreter";
import type { StackValue, InvokeHandler } from "./interpreter";
import type { OsVbcModule, RawInstruction, VliwPacket } from "./bytecode";
import { isOsVbcModule, isVliwPacket } from "./bytecode";

function mod(
  code: RawInstruction[],
  constants: unknown[] = [],
  opts: { argc?: number; localsCount?: number } = {},
): OsVbcModule {
  return {
    version: 1,
    moduleName: "test",
    constants,
    procedures: [
      {
        name: "main",
        codeOffset: 0,
        argc: opts.argc ?? 0,
        localsCount: opts.localsCount ?? Math.max(opts.argc ?? 0, 4),
      },
    ],
    code: [...code, { op: "ret" } as RawInstruction],
  };
}

const pushK = (k: number): RawInstruction =>
  ({ op: "const", type: "i32", k }) as RawInstruction;

async function run(
  m: OsVbcModule,
  args: StackValue[] = [],
  invoke?: InvokeHandler,
) {
  const vm = new VM(m, { invoke, maxSteps: 10_000 });
  const result = await vm.runProcedure(0, args);
  return { result, stack: vm.debugStack };
}

describe("Binary opcodes (Stack Convention: push a, push b, op → a ∘ b)", () => {
  const cases: { name: string; a: number; b: number; op: string; expected: StackValue }[] = [
    { name: "add 2+3=5", a: 2, b: 3, op: "add", expected: 5 },
    { name: "sub 10-3=7", a: 10, b: 3, op: "sub", expected: 7 },
    { name: "sub 3-10=-7", a: 3, b: 10, op: "sub", expected: -7 },
    { name: "sub 0-0=0", a: 0, b: 0, op: "sub", expected: 0 },
    { name: "mul 4*5=20", a: 4, b: 5, op: "mul", expected: 20 },
    { name: "div 15/3=5", a: 15, b: 3, op: "div", expected: 5 },
    { name: "div 7/2=3.5", a: 7, b: 2, op: "div", expected: 3.5 },
    { name: "rem 10%3=1", a: 10, b: 3, op: "rem", expected: 1 },
    { name: "rem 9%3=0", a: 9, b: 3, op: "rem", expected: 0 },
    { name: "lt 2<5=true", a: 2, b: 5, op: "lt", expected: true },
    { name: "lt 5<2=false", a: 5, b: 2, op: "lt", expected: false },
    { name: "lt 3<3=false", a: 3, b: 3, op: "lt", expected: false },
    { name: "le 3<=3=true", a: 3, b: 3, op: "le", expected: true },
    { name: "le 4<=3=false", a: 4, b: 3, op: "le", expected: false },
    { name: "gt 5>2=true", a: 5, b: 2, op: "gt", expected: true },
    { name: "gt 2>5=false", a: 2, b: 5, op: "gt", expected: false },
    { name: "ge 3>=3=true", a: 3, b: 3, op: "ge", expected: true },
    { name: "ge 2>=3=false", a: 2, b: 3, op: "ge", expected: false },
  ];

  for (const c of cases) {
    it(c.name, async () => {
      const m = mod([pushK(0), pushK(1), { op: c.op } as RawInstruction], [c.a, c.b]);
      const { result, stack } = await run(m);
      expect(result).toBe(c.expected);
      expect(stack.length).toBe(0);
    });
  }

  it("div by zero → InterpreterError", async () => {
    const m = mod([pushK(0), pushK(1), { op: "div" } as RawInstruction], [10, 0]);
    await expect(run(m)).rejects.toThrow(InterpreterError);
  });

  it("rem by zero → InterpreterError", async () => {
    const m = mod([pushK(0), pushK(1), { op: "rem" } as RawInstruction], [10, 0]);
    await expect(run(m)).rejects.toThrow(InterpreterError);
  });
});

describe("eq / ne", () => {
  const cases: { name: string; a: unknown; b: unknown; op: "eq" | "ne"; expected: boolean }[] = [
    { name: "eq number same", a: 42, b: 42, op: "eq", expected: true },
    { name: "eq number diff", a: 42, b: 43, op: "eq", expected: false },
    { name: "eq string same", a: "abc", b: "abc", op: "eq", expected: true },
    { name: "eq string diff", a: "abc", b: "xyz", op: "eq", expected: false },
    { name: "eq bool", a: true, b: true, op: "eq", expected: true },
    { name: "eq null", a: null, b: null, op: "eq", expected: true },
    { name: "ne number", a: 1, b: 2, op: "ne", expected: true },
    { name: "ne same", a: 1, b: 1, op: "ne", expected: false },
  ];

  for (const c of cases) {
    it(c.name, async () => {
      const m = mod([pushK(0), pushK(1), { op: c.op } as RawInstruction], [c.a, c.b]);
      const { result } = await run(m);
      expect(result).toBe(c.expected);
    });
  }
});

describe("Literal constants", () => {
  it("const.true", async () => {
    expect((await run(mod([{ op: "const.true" } as RawInstruction]))).result).toBe(true);
  });
  it("const.false", async () => {
    expect((await run(mod([{ op: "const.false" } as RawInstruction]))).result).toBe(false);
  });
  it("const.null", async () => {
    expect((await run(mod([{ op: "const.null" } as RawInstruction]))).result).toBe(null);
  });
});

describe("Locals", () => {
  it("set and get local", async () => {
    const m = mod(
      [pushK(0), { op: "local.set", i: 0 } as RawInstruction, { op: "local.get", i: 0 } as RawInstruction],
      [42],
      { localsCount: 1 },
    );
    expect((await run(m)).result).toBe(42);
  });

  it("procedure args become locals", async () => {
    const m = mod(
      [{ op: "local.get", i: 0 } as RawInstruction, { op: "local.get", i: 1 } as RawInstruction, { op: "add" } as RawInstruction],
      [],
      { argc: 2, localsCount: 2 },
    );
    expect((await run(m, [10, 32])).result).toBe(42);
  });

  it("local.get out of range → InterpreterError", async () => {
    const m = mod([{ op: "local.get", i: 99 } as RawInstruction], [], { localsCount: 1 });
    await expect(run(m)).rejects.toThrow(InterpreterError);
  });
});

describe("Invoke arg order (Stack Convention: push arg0, push arg1, invoke → args=[arg0,arg1])", () => {
  function spyInvoke() {
    const calls: { name: string; args: StackValue[] }[] = [];
    const handler: InvokeHandler = (name, args) => { calls.push({ name, args: [...args] }); return null; };
    return { calls, handler };
  }
  function spyInvokeReturning(returnValue: StackValue) {
    const calls: { name: string; args: StackValue[] }[] = [];
    const handler: InvokeHandler = (name, args) => { calls.push({ name, args: [...args] }); return returnValue; };
    return { calls, handler };
  }

  it("2-arg invoke: push key, push value → args=[key, value]", async () => {
    const { calls, handler } = spyInvoke();
    const m = mod([pushK(0), pushK(1), { op: "invoke", name: "система.хранилище.записать" } as RawInstruction], ["mykey", "myval"]);
    await run(m, [], handler);
    expect(calls[0].args).toEqual(["mykey", "myval"]);
  });

  it("2-arg invoke: push arr, push idx → args=[arr, idx]", async () => {
    const arr = [10, 20, 30];
    const { calls, handler } = spyInvokeReturning(20);
    const m = mod([pushK(0), pushK(1), { op: "invoke", name: "система.массив.получить" } as RawInstruction], [arr, 1]);
    const { result } = await run(m, [], handler);
    expect(calls[0].args).toEqual([arr, 1]);
    expect(result).toBe(20);
  });

  it("2-arg invoke: строка.объединить", async () => {
    const { calls, handler } = spyInvokeReturning("HelloWorld");
    const m = mod([pushK(0), pushK(1), { op: "invoke", name: "система.строка.объединить" } as RawInstruction], ["Hello", "World"]);
    await run(m, [], handler);
    expect(calls[0].args).toEqual(["Hello", "World"]);
  });

  it("1-arg invoke", async () => {
    const { calls, handler } = spyInvokeReturning("stored_val");
    const m = mod([pushK(0), { op: "invoke", name: "система.хранилище.прочитать" } as RawInstruction], ["mykey"]);
    const { result } = await run(m, [], handler);
    expect(calls[0].args).toEqual(["mykey"]);
    expect(result).toBe("stored_val");
  });

  it("0-arg invoke не снимает уже лежащее значение", async () => {
    const { calls, handler } = spyInvokeReturning(null);
    const m = mod(
      [pushK(0), { op: "invoke", name: "система.окно.получить_события" } as RawInstruction, { op: "pop" }],
      [999],
    );
    const { result } = await run(m, [], handler);
    expect(calls[0].args.length).toBe(0);
    expect(result).toBe(999);
  });

  it("3-arg invoke", async () => {
    const { calls, handler } = spyInvokeReturning("btn1");
    const m = mod(
      [pushK(0), pushK(1), pushK(2), { op: "invoke", name: "система.интерфейс.кнопка" } as RawInstruction],
      ["container1", "Click me", "btn1"],
    );
    await run(m, [], handler);
    expect(calls[0].args).toEqual(["container1", "Click me", "btn1"]);
  });

  it("invoke returning null кладёт null; pop снимает его, предыдущее значение цело", async () => {
    const { handler } = spyInvokeReturning(null);
    const m = mod(
      [pushK(0), pushK(1), { op: "invoke", name: "система.лог.вывести" } as RawInstruction, { op: "pop" }],
      [42, "x"],
    );
    expect((await run(m, [], handler)).result).toBe(42);
  });

  it("invoke returning value DOES push to stack", async () => {
    const { handler } = spyInvokeReturning(12345);
    const m = mod([{ op: "invoke", name: "система.время.сейчас" } as RawInstruction], []);
    expect((await run(m, [], handler)).result).toBe(12345);
  });
});

describe("система.строка расширенная", () => {
  it("длина: система.строка.длина('привет') === 6", async () => {
    const m = mod(
      [pushK(0), { op: "invoke", name: "система.строка.длина" } as RawInstruction],
      ["привет"],
    );
    expect((await run(m)).result).toBe(6);
  });

  it("содержит: система.строка.содержит('привет мир', 'мир') === true", async () => {
    const m = mod(
      [pushK(0), pushK(1), { op: "invoke", name: "система.строка.содержит" } as RawInstruction],
      ["привет мир", "мир"],
    );
    expect((await run(m)).result).toBe(true);
  });

  it("начинается_с: система.строка.начинается_с('привет', 'при') === true", async () => {
    const m = mod(
      [pushK(0), pushK(1), { op: "invoke", name: "система.строка.начинается_с" } as RawInstruction],
      ["привет", "при"],
    );
    expect((await run(m)).result).toBe(true);
  });

  it("заканчивается_на: система.строка.заканчивается_на('привет', 'вет') === true", async () => {
    const m = mod(
      [pushK(0), pushK(1), { op: "invoke", name: "система.строка.заканчивается_на" } as RawInstruction],
      ["привет", "вет"],
    );
    expect((await run(m)).result).toBe(true);
  });

  it("подстрока: система.строка.подстрока('привет', 0, 3) === 'при'", async () => {
    const m = mod(
      [pushK(0), pushK(1), pushK(2), { op: "invoke", name: "система.строка.подстрока" } as RawInstruction],
      ["привет", 0, 3],
    );
    expect((await run(m)).result).toBe("при");
  });

  it("в_верхний: система.строка.в_верхний('hello') === 'HELLO'", async () => {
    const m = mod(
      [pushK(0), { op: "invoke", name: "система.строка.в_верхний" } as RawInstruction],
      ["hello"],
    );
    expect((await run(m)).result).toBe("HELLO");
  });

  it("заменить: система.строка.заменить('а,б,в', ',', ' ') === 'а б в'", async () => {
    const m = mod(
      [pushK(0), pushK(1), pushK(2), { op: "invoke", name: "система.строка.заменить" } as RawInstruction],
      ["а,б,в", ",", " "],
    );
    expect((await run(m)).result).toBe("а б в");
  });

  it("разделить: система.строка.разделить('a,b,c', ',') → массив из 3 элементов", async () => {
    const m = mod(
      [pushK(0), pushK(1), { op: "invoke", name: "система.строка.разделить" } as RawInstruction],
      ["a,b,c", ","],
    );
    const result = (await run(m)).result;
    expect(Array.isArray(result)).toBe(true);
    expect((result as string[]).length).toBe(3);
    expect((result as string[])).toEqual(["a", "b", "c"]);
  });
});

describe("Control flow", () => {
  it("jmp skips instructions", async () => {
    const m = mod([{ op: "jmp", off: 2 } as RawInstruction, pushK(0), pushK(1)], [111, 999]);
    expect((await run(m)).result).toBe(999);
  });

  it("jmp_if: jumps when true", async () => {
    const m = mod(
      [{ op: "const.true" } as RawInstruction, { op: "jmp_if", off: 3 } as RawInstruction, pushK(0), pushK(1)],
      [0, 42],
    );
    expect((await run(m)).result).toBe(42);
  });

  it("jmp_if: falls through when false", async () => {
    const m = mod(
      [{ op: "const.false" } as RawInstruction, { op: "jmp_if", off: 3 } as RawInstruction, pushK(0)],
      [42],
    );
    expect((await run(m)).result).toBe(42);
  });

  it("jmp_if_not: jumps when false", async () => {
    const m = mod(
      [{ op: "const.false" } as RawInstruction, { op: "jmp_if_not", off: 3 } as RawInstruction, pushK(0), pushK(1)],
      [0, 77],
    );
    expect((await run(m)).result).toBe(77);
  });

  it("jmp_if_not: falls through when true", async () => {
    const m = mod(
      [{ op: "const.true" } as RawInstruction, { op: "jmp_if_not", off: 3 } as RawInstruction, pushK(0)],
      [88],
    );
    expect((await run(m)).result).toBe(88);
  });

  it("maxSteps exceeded → InterpreterError", async () => {
    const m = mod([{ op: "jmp", off: 0 } as RawInstruction]);
    await expect(new VM(m, { maxSteps: 100 }).runProcedure(0, [])).rejects.toThrow(InterpreterError);
  });
});

describe("call / ret", () => {
  it("call passes args in natural order and returns value", async () => {
    const m: OsVbcModule = {
      version: 1,
      moduleName: "test_call",
      constants: [10, 3],
      procedures: [
        { name: "main", codeOffset: 0, argc: 0, localsCount: 1 },
        { name: "sub2", codeOffset: 4, argc: 2, localsCount: 2 },
      ],
      code: [
        { op: "const", type: "i32", k: 0 } as RawInstruction,
        { op: "const", type: "i32", k: 1 } as RawInstruction,
        { op: "call", fi: 1 } as RawInstruction,
        { op: "ret" } as RawInstruction,
        { op: "local.get", i: 0 } as RawInstruction,
        { op: "local.get", i: 1 } as RawInstruction,
        { op: "sub" } as RawInstruction,
        { op: "ret" } as RawInstruction,
      ],
    };
    expect(await new VM(m, { maxSteps: 100 }).runProcedure(0, [])).toBe(7);
  });

  it("call: arg order preserved for 3 args", async () => {
    const m: OsVbcModule = {
      version: 1,
      moduleName: "test_call3",
      constants: ["a", "b", "c"],
      procedures: [
        { name: "main", codeOffset: 0, argc: 0, localsCount: 0 },
        { name: "echo3", codeOffset: 5, argc: 3, localsCount: 3 },
      ],
      code: [
        { op: "const", type: "str", k: 0 } as RawInstruction,
        { op: "const", type: "str", k: 1 } as RawInstruction,
        { op: "const", type: "str", k: 2 } as RawInstruction,
        { op: "call", fi: 1 } as RawInstruction,
        { op: "ret" } as RawInstruction,
        { op: "local.get", i: 0 } as RawInstruction,
        { op: "ret" } as RawInstruction,
      ],
    };
    expect(await new VM(m, { maxSteps: 100 }).runProcedure(0, [])).toBe("a");
  });
});

describe("VLIW bytecode v2", () => {
  const fixturePath = path.join(__dirname, "..", "fixtures", "vliw-example.osvbc.json");

  it("loads and validates structure", async () => {
    const data = JSON.parse(await fs.readFile(fixturePath, "utf-8")) as unknown;
    expect(isOsVbcModule(data)).toBe(true);
    const m = data as OsVbcModule;
    expect(m.version).toBe(2);
    expect(m.vliwSlots).toBe(4);
    const proc = m.procedures.find((p) => p.name === "пример");
    expect(proc).toBeTruthy();
    expect(proc!.argc).toBe(0);
    expect(proc!.localsCount).toBe(2);
  });

  it("validates packet: 3 slots, 2 deps", async () => {
    const m = JSON.parse(await fs.readFile(fixturePath, "utf-8")) as OsVbcModule;
    const pkt = m.code.find((el) => isVliwPacket(el)) as VliwPacket;
    expect(pkt).toBeTruthy();
    expect(pkt.slots.length).toBe(3);
    // deps — опциональный hint планировщика; проверяем только если присутствует
    expect(pkt.deps?.length ?? 0).toBe(2);
  });

  it("VM run: пример returns 2", async () => {
    const m = JSON.parse(await fs.readFile(fixturePath, "utf-8")) as OsVbcModule;
    const vm = new VM(m, { maxSteps: 10_000 });
    expect(await vm.runProcedure(vm.findProcedureIndex("пример"), [])).toBe(2);
  });

  it("obj.new / obj.set / obj.get", async () => {
    const m = mod(
      [
        { op: "obj.new" } as RawInstruction,
        { op: "dup" } as RawInstruction,
        { op: "const", type: "str", k: 0 } as RawInstruction,
        { op: "const", type: "i32", k: 1 } as RawInstruction,
        { op: "obj.set" } as RawInstruction,
        { op: "const", type: "str", k: 0 } as RawInstruction,
        { op: "obj.get" } as RawInstruction,
      ],
      ["x", 42],
    );
    const { result } = await run(m);
    expect(result).toBe(42);
  });

  it("VM runs version 2 without crash", async () => {
    const m = JSON.parse(await fs.readFile(fixturePath, "utf-8")) as OsVbcModule;
    const vm = new VM(m, { maxSteps: 10_000 });
    await vm.runProcedure(vm.findProcedureIndex("пример"), []);
  });
});

describe("runProgram multi-module execution", () => {
  it("два модуля: B__главная вызывает A__ping без исключений", async () => {
    const moduleA: OsVbcModule = {
      version: 1,
      moduleName: "A",
      constants: [],
      procedures: [{ name: "A__ping", codeOffset: 0, argc: 0, localsCount: 0 }],
      code: [{ op: "ret" } as RawInstruction],
    };
    const moduleB: OsVbcModule = {
      version: 1,
      moduleName: "B",
      constants: [],
      procedures: [
        { name: "A__ping", codeOffset: 0, argc: 0, localsCount: 0 },
        { name: "B__главная", codeOffset: 1, argc: 0, localsCount: 0 },
      ],
      code: [
        { op: "ret" } as RawInstruction,
        { op: "call", fi: 0 } as RawInstruction,
        { op: "ret" } as RawInstruction,
      ],
    };

    await expect(runProgram([moduleA, moduleB], { preferredModuleName: "B" })).resolves.toBeUndefined();
  });

  it("одномодульный режим через runProgram работает как раньше", async () => {
    const single = mod([pushK(0)], [42]);
    await expect(runProgram([single])).resolves.toBeUndefined();
  });
});
