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
    expect(OpCode.EQ).toBe("eq");
    expect(OpCode.LT).toBe("lt");
    expect(OpCode.GT).toBe("gt");
    expect(OpCode.AND).toBe("and");
    expect(OpCode.OR).toBe("or");
    expect(OpCode.NOT).toBe("not");
    expect(OpCode.JUMP).toBe("jmp");
    expect(OpCode.JUMP_IF_FALSE).toBe("jmp_if_not");
    expect(OpCode.CALL).toBe("call");
    expect(OpCode.RETURN).toBe("ret");
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

  it("сравнение eq/lt/gt и логика and/or/not", async () => {
    const cmp = tinyMod(
      [
        { op: OpCode.PUSH, type: "i32", k: 0 } as RawInstruction,
        { op: OpCode.PUSH, type: "i32", k: 1 } as RawInstruction,
        { op: OpCode.EQ } as RawInstruction,
      ],
      [2, 2],
    );
    expect(await new Interpreter(cmp).runProcedure(0, [])).toBe(true);

    const lt = tinyMod(
      [
        { op: OpCode.PUSH, type: "i32", k: 0 } as RawInstruction,
        { op: OpCode.PUSH, type: "i32", k: 1 } as RawInstruction,
        { op: OpCode.LT } as RawInstruction,
      ],
      [1, 5],
    );
    expect(await new Interpreter(lt).runProcedure(0, [])).toBe(true);

    const gt = tinyMod(
      [
        { op: OpCode.PUSH, type: "i32", k: 0 } as RawInstruction,
        { op: OpCode.PUSH, type: "i32", k: 1 } as RawInstruction,
        { op: OpCode.GT } as RawInstruction,
      ],
      [3, 1],
    );
    expect(await new Interpreter(gt).runProcedure(0, [])).toBe(true);

    const andTrue = tinyMod(
      [
        { op: "const.true" } as RawInstruction,
        { op: "const.true" } as RawInstruction,
        { op: OpCode.AND } as RawInstruction,
      ],
    );
    expect(await new Interpreter(andTrue).runProcedure(0, [])).toBe(true);

    const orFalse = tinyMod(
      [
        { op: "const.false" } as RawInstruction,
        { op: "const.true" } as RawInstruction,
        { op: OpCode.OR } as RawInstruction,
      ],
    );
    expect(await new Interpreter(orFalse).runProcedure(0, [])).toBe(true);

    const notTrue = tinyMod([{ op: "const.true" } as RawInstruction, { op: OpCode.NOT } as RawInstruction]);
    expect(await new Interpreter(notTrue).runProcedure(0, [])).toBe(false);
  });

  it("управление потоком: JUMP, JUMP_IF_FALSE, CALL, RETURN", async () => {
    const skipMid = tinyMod(
      [{ op: OpCode.JUMP, off: 2 } as RawInstruction, { op: OpCode.PUSH, type: "i32", k: 0 } as RawInstruction, { op: OpCode.PUSH, type: "i32", k: 1 } as RawInstruction],
      [111, 999],
    );
    expect(await new Interpreter(skipMid).runProcedure(0, [])).toBe(999);

    const ifFalseSkip = tinyMod(
      [
        { op: "const.false" } as RawInstruction,
        { op: OpCode.JUMP_IF_FALSE, off: 3 } as RawInstruction,
        { op: OpCode.PUSH, type: "i32", k: 0 } as RawInstruction,
        { op: OpCode.PUSH, type: "i32", k: 1 } as RawInstruction,
      ],
      [0, 77],
    );
    expect(await new Interpreter(ifFalseSkip).runProcedure(0, [])).toBe(77);

    const callMod: OsVbcModule = {
      version: 1,
      moduleName: "t_call",
      constants: [10, 3],
      procedures: [
        { name: "main", codeOffset: 0, argc: 0, localsCount: 1 },
        { name: "sub2", codeOffset: 4, argc: 2, localsCount: 2 },
      ],
      code: [
        { op: OpCode.PUSH, type: "i32", k: 0 } as RawInstruction,
        { op: OpCode.PUSH, type: "i32", k: 1 } as RawInstruction,
        { op: OpCode.CALL, fi: 1 } as RawInstruction,
        { op: OpCode.RETURN } as RawInstruction,
        { op: "local.get", i: 0 } as RawInstruction,
        { op: "local.get", i: 1 } as RawInstruction,
        { op: OpCode.SUB } as RawInstruction,
        { op: OpCode.RETURN } as RawInstruction,
      ],
    };
    expect(await new Interpreter(callMod).runProcedure(0, [])).toBe(7);
  });
});
