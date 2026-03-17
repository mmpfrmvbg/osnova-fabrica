/**
 * Табличные unit-тесты для VM — фиксация Stack Convention v0.1.
 * Запуск: npx tsx --test src/tools/osnova-runtime/vm/interpreter.test.ts
 *    или: node --test dist/tools/osnova-runtime/vm/interpreter.test.js
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs/promises";
import * as path from "path";
import { VM, InterpreterError } from "./interpreter";
import type { StackValue, InvokeHandler } from "./interpreter";
import type { OsVbcModule, RawInstruction, VliwPacket } from "./bytecode";
import { isOsVbcModule, isVliwPacket } from "./bytecode";

// ─── Helpers ───────────────────────────────────────────────

/** Минимальный модуль: одна процедура "main", argc/localsCount настраиваемые. */
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

/** Сокращение: push константу по индексу. */
const pushK = (k: number): RawInstruction =>
  ({ op: "const", type: "i32", k }) as RawInstruction;

/** Запустить модуль, вернуть { result, stack }. */
async function run(
  m: OsVbcModule,
  args: StackValue[] = [],
  invoke?: InvokeHandler,
) {
  const vm = new VM(m, { invoke, maxSteps: 10_000 });
  const result = await vm.runProcedure(0, args);
  return { result, stack: vm.debugStack };
}

// ─── 1. Бинарные опкоды ────────────────────────────────────

describe("Binary opcodes (Stack Convention: push a, push b, op → a ∘ b)", () => {
  const cases: {
    name: string;
    a: number;
    b: number;
    op: string;
    expected: StackValue;
  }[] = [
    // Арифметика
    { name: "add 2+3=5", a: 2, b: 3, op: "add", expected: 5 },
    { name: "sub 10-3=7", a: 10, b: 3, op: "sub", expected: 7 },
    { name: "sub 3-10=-7", a: 3, b: 10, op: "sub", expected: -7 },
    { name: "sub 0-0=0", a: 0, b: 0, op: "sub", expected: 0 },
    { name: "mul 4*5=20", a: 4, b: 5, op: "mul", expected: 20 },
    { name: "div 15/3=5", a: 15, b: 3, op: "div", expected: 5 },
    { name: "div 7/2=3.5", a: 7, b: 2, op: "div", expected: 3.5 },
    { name: "rem 10%3=1", a: 10, b: 3, op: "rem", expected: 1 },
    { name: "rem 9%3=0", a: 9, b: 3, op: "rem", expected: 0 },
    // Сравнения
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
      const m = mod(
        [pushK(0), pushK(1), { op: c.op } as RawInstruction],
        [c.a, c.b],
      );
      const { result, stack } = await run(m);
      assert.strictEqual(result, c.expected);
      assert.strictEqual(stack.length, 0, "stack should be empty after ret");
    });
  }

  it("div by zero → InterpreterError", async () => {
    const m = mod([pushK(0), pushK(1), { op: "div" } as RawInstruction], [
      10,
      0,
    ]);
    await assert.rejects(() => run(m), InterpreterError);
  });

  it("rem by zero → InterpreterError", async () => {
    const m = mod([pushK(0), pushK(1), { op: "rem" } as RawInstruction], [
      10,
      0,
    ]);
    await assert.rejects(() => run(m), InterpreterError);
  });
});

// ─── 2. eq / ne (коммутативные, но тестируем разные типы) ──

describe("eq / ne", () => {
  const cases: {
    name: string;
    a: unknown;
    b: unknown;
    op: "eq" | "ne";
    expected: boolean;
  }[] = [
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
      const m = mod(
        [pushK(0), pushK(1), { op: c.op } as RawInstruction],
        [c.a, c.b],
      );
      const { result } = await run(m);
      assert.strictEqual(result, c.expected);
    });
  }
});

// ─── 3. const.true / const.false / const.null ──────────────

describe("Literal constants", () => {
  it("const.true", async () => {
    const m = mod([{ op: "const.true" } as RawInstruction]);
    const { result } = await run(m);
    assert.strictEqual(result, true);
  });

  it("const.false", async () => {
    const m = mod([{ op: "const.false" } as RawInstruction]);
    const { result } = await run(m);
    assert.strictEqual(result, false);
  });

  it("const.null", async () => {
    const m = mod([{ op: "const.null" } as RawInstruction]);
    const { result } = await run(m);
    assert.strictEqual(result, null);
  });
});

// ─── 4. local.get / local.set ──────────────────────────────

describe("Locals", () => {
  it("set and get local", async () => {
    const m = mod(
      [
        pushK(0),
        { op: "local.set", i: 0 } as RawInstruction,
        { op: "local.get", i: 0 } as RawInstruction,
      ],
      [42],
      { localsCount: 1 },
    );
    const { result } = await run(m);
    assert.strictEqual(result, 42);
  });

  it("procedure args become locals", async () => {
    const m = mod(
      [
        { op: "local.get", i: 0 } as RawInstruction,
        { op: "local.get", i: 1 } as RawInstruction,
        { op: "add" } as RawInstruction,
      ],
      [],
      { argc: 2, localsCount: 2 },
    );
    const { result } = await run(m, [10, 32]);
    assert.strictEqual(result, 42);
  });

  it("local.get out of range → InterpreterError", async () => {
    const m = mod(
      [{ op: "local.get", i: 99 } as RawInstruction],
      [],
      { localsCount: 1 },
    );
    await assert.rejects(() => run(m), InterpreterError);
  });
});

// ─── 5. Invoke: порядок аргументов ─────────────────────────

describe("Invoke arg order (Stack Convention: push arg0, push arg1, invoke → args=[arg0,arg1])", () => {
  function spyInvoke() {
    const calls: { name: string; args: StackValue[] }[] = [];
    const handler: InvokeHandler = (name, args) => {
      calls.push({ name, args: [...args] });
      return null;
    };
    return { calls, handler };
  }

  function spyInvokeReturning(returnValue: StackValue) {
    const calls: { name: string; args: StackValue[] }[] = [];
    const handler: InvokeHandler = (name, args) => {
      calls.push({ name, args: [...args] });
      return returnValue;
    };
    return { calls, handler };
  }

  it("2-arg invoke: push key, push value → args=[key, value]", async () => {
    const { calls, handler } = spyInvoke();
    const m = mod(
      [
        pushK(0),
        pushK(1),
        { op: "invoke", name: "система.хранилище.записать" } as RawInstruction,
      ],
      ["mykey", "myval"],
    );
    await run(m, [], handler);
    assert.strictEqual(calls.length, 1);
    assert.strictEqual(calls[0].name, "система.хранилище.записать");
    assert.deepStrictEqual(calls[0].args, ["mykey", "myval"]);
  });

  it("2-arg invoke: push arr, push idx → args=[arr, idx]", async () => {
    const arr = [10, 20, 30];
    const { calls, handler } = spyInvokeReturning(20);
    const m = mod(
      [
        pushK(0),
        pushK(1),
        { op: "invoke", name: "система.массив.получить" } as RawInstruction,
      ],
      [arr, 1],
    );
    const { result } = await run(m, [], handler);
    assert.deepStrictEqual(calls[0].args, [arr, 1]);
    assert.strictEqual(result, 20);
  });

  it("2-arg invoke: push a, push b → args=[a, b] (строка.объединить)", async () => {
    const { calls, handler } = spyInvokeReturning("HelloWorld");
    const m = mod(
      [
        pushK(0),
        pushK(1),
        { op: "invoke", name: "система.строка.объединить" } as RawInstruction,
      ],
      ["Hello", "World"],
    );
    await run(m, [], handler);
    assert.deepStrictEqual(calls[0].args, ["Hello", "World"]);
  });

  it("1-arg invoke: push key → args=[key]", async () => {
    const { calls, handler } = spyInvokeReturning("stored_val");
    const m = mod(
      [
        pushK(0),
        { op: "invoke", name: "система.хранилище.прочитать" } as RawInstruction,
      ],
      ["mykey"],
    );
    const { result } = await run(m, [], handler);
    assert.deepStrictEqual(calls[0].args, ["mykey"]);
    assert.strictEqual(result, "stored_val");
  });

  it("0-arg invoke: получить_события does not pop anything", async () => {
    const { calls, handler } = spyInvokeReturning(null);
    const m = mod(
      [
        pushK(0),
        {
          op: "invoke",
          name: "система.окно.получить_события",
        } as RawInstruction,
      ],
      [999],
    );
    const { result } = await run(m, [], handler);
    assert.strictEqual(
      calls[0].args.length,
      0,
      "получить_события should receive 0 args",
    );
    assert.strictEqual(result, 999, "sentinel should remain on stack");
  });

  it("3-arg invoke: push parent, push text, push id → args=[parent,text,id]", async () => {
    const { calls, handler } = spyInvokeReturning("btn1");
    const m = mod(
      [
        pushK(0),
        pushK(1),
        pushK(2),
        { op: "invoke", name: "система.интерфейс.кнопка" } as RawInstruction,
      ],
      ["container1", "Click me", "btn1"],
    );
    await run(m, [], handler);
    assert.deepStrictEqual(calls[0].args, [
      "container1",
      "Click me",
      "btn1",
    ]);
  });

  it("invoke returning null does NOT push to stack", async () => {
    const { handler } = spyInvokeReturning(null);
    const m = mod(
      [
        pushK(0),
        pushK(1),
        { op: "invoke", name: "система.лог.вывести" } as RawInstruction,
      ],
      [42, "x"],
    );
    const { result } = await run(m, [], handler);
    assert.strictEqual(
      result,
      42,
      "null return should not push → sentinel on top",
    );
  });

  it("invoke returning value DOES push to stack", async () => {
    const { handler } = spyInvokeReturning(12345);
    const m = mod(
      [{ op: "invoke", name: "система.время.сейчас" } as RawInstruction],
      [],
    );
    const { result } = await run(m, [], handler);
    assert.strictEqual(result, 12345);
  });
});

// ─── 6. Control flow: jmp, jmp_if, jmp_if_not ─────────────

describe("Control flow", () => {
  it("jmp skips instructions", async () => {
    const m = mod(
      [
        { op: "jmp", off: 2 } as RawInstruction,
        pushK(0),
        pushK(1),
      ],
      [111, 999],
    );
    const { result } = await run(m);
    assert.strictEqual(result, 999);
  });

  it("jmp_if: jumps when true on stack", async () => {
    const m = mod(
      [
        { op: "const.true" } as RawInstruction,
        { op: "jmp_if", off: 3 } as RawInstruction,
        pushK(0),
        pushK(1),
      ],
      [0, 42],
    );
    const { result } = await run(m);
    assert.strictEqual(result, 42);
  });

  it("jmp_if: falls through when false on stack", async () => {
    const m = mod(
      [
        { op: "const.false" } as RawInstruction,
        { op: "jmp_if", off: 3 } as RawInstruction,
        pushK(0),
      ],
      [42],
    );
    const { result } = await run(m);
    assert.strictEqual(result, 42);
  });

  it("jmp_if_not: jumps when NOT true on stack", async () => {
    const m = mod(
      [
        { op: "const.false" } as RawInstruction,
        { op: "jmp_if_not", off: 3 } as RawInstruction,
        pushK(0),
        pushK(1),
      ],
      [0, 77],
    );
    const { result } = await run(m);
    assert.strictEqual(result, 77);
  });

  it("jmp_if_not: falls through when true on stack", async () => {
    const m = mod(
      [
        { op: "const.true" } as RawInstruction,
        { op: "jmp_if_not", off: 3 } as RawInstruction,
        pushK(0),
      ],
      [88],
    );
    const { result } = await run(m);
    assert.strictEqual(result, 88);
  });

  it("maxSteps exceeded → InterpreterError", async () => {
    const m = mod([{ op: "jmp", off: 0 } as RawInstruction]);
    const vm = new VM(m, { maxSteps: 100 });
    await assert.rejects(() => vm.runProcedure(0, []), InterpreterError);
  });
});

// ─── 7. call / ret: межпроцедурный вызов ──────────────────

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

    const vm = new VM(m, { maxSteps: 100 });
    const result = await vm.runProcedure(0, []);
    assert.strictEqual(result, 7);
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

    const vm = new VM(m, { maxSteps: 100 });
    const result = await vm.runProcedure(0, []);
    assert.strictEqual(result, "a");
  });
});

// ─── 8. VLIW bytecode v2 (golden: vliw-example.osvbc.json) ─

describe("VLIW bytecode v2", () => {
  const fixturePath = path.join(__dirname, "..", "fixtures", "vliw-example.osvbc.json");

  it("loads vliw-example.osvbc.json and validates structure", async () => {
    const raw = await fs.readFile(fixturePath, "utf-8");
    const data = JSON.parse(raw) as unknown;
    assert.ok(isOsVbcModule(data), "file must be valid OsVbcModule");
    const m = data as OsVbcModule;
    assert.strictEqual(m.version, 2, "version === 2");
    assert.strictEqual(m.vliwSlots, 4, "vliwSlots === 4");
    const proc = m.procedures.find((p) => p.name === "пример");
    assert.ok(proc, "procedure пример must exist");
    assert.strictEqual(proc.argc, 0);
    assert.strictEqual(proc.localsCount, 2);
    assert.ok(proc.deps, "deps must be present");
    assert.ok(Array.isArray(proc.deps.blocks) && proc.deps.blocks.length >= 2);
    assert.ok(Array.isArray(proc.deps.edges) && proc.deps.edges.length >= 1);
  });

  it("validates packet in code: packet true, 3 slots, deps two pairs", async () => {
    const raw = await fs.readFile(fixturePath, "utf-8");
    const m = JSON.parse(raw) as OsVbcModule;
    const packetEl = m.code.find((el) => isVliwPacket(el));
    assert.ok(packetEl && isVliwPacket(packetEl), "code must contain one packet element");
    const pkt = packetEl as VliwPacket;
    assert.strictEqual(pkt.slots.length, 3, "packet must have 3 slots");
    assert.ok(Array.isArray(pkt.deps) && pkt.deps.length === 2, "packet deps must be 2 pairs");
  });

  it("VM run: procedure пример returns 2 (1+1 in packet, sequential slot execution)", async () => {
    const raw = await fs.readFile(fixturePath, "utf-8");
    const m = JSON.parse(raw) as OsVbcModule;
    const vm = new VM(m, { maxSteps: 10_000 });
    const idx = vm.findProcedureIndex("пример");
    const result = await vm.runProcedure(idx, []);
    assert.strictEqual(result, 2, "пример must return 2 (1+1 from packet)");
  });

  it("VM runs version 2 and ignores deps (no crash)", async () => {
    const raw = await fs.readFile(fixturePath, "utf-8");
    const m = JSON.parse(raw) as OsVbcModule;
    const vm = new VM(m, { maxSteps: 10_000 });
    await vm.runProcedure(vm.findProcedureIndex("пример"), []);
    assert.ok(true, "version 2 + deps do not affect interpreter");
  });
});
