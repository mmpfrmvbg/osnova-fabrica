/**
 * Фасад Interpreter (executionStack, OpCode) и инструкция pop.
 */

import { describe, it, expect } from "vitest";
import { Interpreter, InterpreterError, OpCode } from "./interpreter";
import type { OsVbcModule, RawInstruction } from "./vm/bytecode";

function tinyMod(code: RawInstruction[], constants: unknown[] = []): OsVbcModule {
  return {
    version: 1,
    moduleName: "t",
    constants,
    procedures: [{ name: "main", codeOffset: 0, argc: 0, localsCount: 4 }],
    code: [...code, { op: "ret" } as RawInstruction],
  };
}

describe("Interpreter + OpCode stack ops", () => {
  it("OpCode.PUSH maps to const; после ret executionStack показывает остаток", async () => {
    expect(OpCode.PUSH).toBe("const");
    expect(OpCode.DUP).toBe("dup");
    expect(OpCode.ADD).toBe("add");
    expect(OpCode.SUB).toBe("sub");
    expect(OpCode.MUL).toBe("mul");
    expect(OpCode.DIV).toBe("div");
    const m = tinyMod([{ op: "const", type: "i32", k: 0 } as RawInstruction], [7]);
    const ip = new Interpreter(m);
    await ip.runProcedure(0, []);
    expect(ip.executionStack.length).toBe(0);
    // const 7, dup → [7,7]; ret снимает вершину как возврат → на стеке остаётся [7]
    const m2 = tinyMod(
      [{ op: "const", type: "i32", k: 0 } as RawInstruction, { op: "dup" } as RawInstruction],
      [7],
    );
    const ip2 = new Interpreter(m2);
    await ip2.runProcedure(0, []);
    expect(ip2.executionStack).toEqual([7]);
  });

  it("OpCode.POP removes top; empty stack pop → InterpreterError", async () => {
    expect(OpCode.POP).toBe("pop");
    const m = tinyMod(
      [
        { op: "const", type: "i32", k: 0 } as RawInstruction,
        { op: "const", type: "i32", k: 1 } as RawInstruction,
        { op: "pop" } as RawInstruction,
      ],
      [1, 2],
    );
    const ip = new Interpreter(m);
    const v = await ip.runProcedure(0, []);
    expect(v).toBe(1);
    const empty = tinyMod([{ op: "pop" } as RawInstruction]);
    await expect(new Interpreter(empty).runProcedure(0, [])).rejects.toThrow(InterpreterError);
  });

  it("арифметика: add/sub/mul; div по нулю → InterpreterError", async () => {
    const sum = tinyMod(
      [
        { op: OpCode.PUSH, type: "i32", k: 0 } as RawInstruction,
        { op: OpCode.PUSH, type: "i32", k: 1 } as RawInstruction,
        { op: OpCode.ADD } as RawInstruction,
      ],
      [10, 3],
    );
    expect(await new Interpreter(sum).runProcedure(0, [])).toBe(13);

    const divZero = tinyMod(
      [
        { op: OpCode.PUSH, type: "i32", k: 0 } as RawInstruction,
        { op: OpCode.PUSH, type: "i32", k: 1 } as RawInstruction,
        { op: OpCode.DIV } as RawInstruction,
      ],
      [1, 0],
    );
    await expect(new Interpreter(divZero).runProcedure(0, [])).rejects.toMatchObject({
      message: expect.stringContaining("Division by zero"),
    });
  });
});
