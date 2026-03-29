/**
 * Фасад Interpreter: executionStack, OpCode, пошаговый interpret и runProcedure для стека/арифметики/сравнений/логики.
 */

import { describe, it, expect } from "vitest";
import { Interpreter, InterpreterError, OpCode, VM, runProgram, loadModule } from "./index";
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
  it("публичный barrel (index) отдаёт runProgram и loadModule вместе с vm.ts-поверхностью", () => {
    expect(typeof runProgram).toBe("function");
    expect(typeof loadModule).toBe("function");
  });

  it("interpret: одна инструкция const кладёт значение на стек", async () => {
    const m = tinyMod([], [42]);
    const ip = new Interpreter(m);
    await ip.interpret({ op: "const", type: "i32", k: 0 } as RawInstruction);
    expect(ip.executionStack).toEqual([42]);
  });

  it("interpret: const + pop по шагам очищает executionStack", async () => {
    const m = tinyMod([], [99]);
    const ip = new Interpreter(m);
    await ip.interpret({ op: "const", type: "i32", k: 0 } as RawInstruction);
    expect(ip.executionStack).toEqual([99]);
    await ip.interpret({ op: "pop" } as RawInstruction);
    expect(ip.executionStack).toEqual([]);
  });

  it("interpret: const + dup по шагам дублирует вершину на executionStack", async () => {
    const m = tinyMod([], [7]);
    const ip = new Interpreter(m);
    await ip.interpret({ op: "const", type: "i32", k: 0 } as RawInstruction);
    await ip.interpret({ op: "dup" } as RawInstruction);
    expect(ip.executionStack).toEqual([7, 7]);
  });

  it("interpret: по шагам add / lt / and без runProcedure", async () => {
    const ipAdd = new Interpreter(tinyMod([], [2, 3]));
    await ipAdd.interpret({ op: OpCode.PUSH, type: "i32", k: 0 } as RawInstruction);
    await ipAdd.interpret({ op: OpCode.PUSH, type: "i32", k: 1 } as RawInstruction);
    await ipAdd.interpret({ op: OpCode.ADD } as RawInstruction);
    expect(ipAdd.executionStack).toEqual([5]);

    const ipLt = new Interpreter(tinyMod([], [1, 2]));
    await ipLt.interpret({ op: OpCode.PUSH, type: "i32", k: 0 } as RawInstruction);
    await ipLt.interpret({ op: OpCode.PUSH, type: "i32", k: 1 } as RawInstruction);
    await ipLt.interpret({ op: OpCode.LT } as RawInstruction);
    expect(ipLt.executionStack).toEqual([true]);

    const ipAnd = new Interpreter(tinyMod([]));
    await ipAnd.interpret({ op: "const.true" } as RawInstruction);
    await ipAnd.interpret({ op: "const.false" } as RawInstruction);
    await ipAnd.interpret({ op: OpCode.AND } as RawInstruction);
    expect(ipAnd.executionStack).toEqual([false]);
  });

  describe("PUSH / POP / DUP", () => {
    it("OpCode.PUSH maps to const; после ret executionStack показывает остаток; DUP дублирует вершину", async () => {
      expect(OpCode.PUSH).toBe("const");
      expect(OpCode.DUP).toBe("dup");
      expect(OpCode.ADD).toBe("add");
      expect(OpCode.SUB).toBe("sub");
      expect(OpCode.MUL).toBe("mul");
      expect(OpCode.DIV).toBe("div");
      expect(OpCode.REM).toBe("rem");
      expect(OpCode.EQ).toBe("eq");
      expect(OpCode.NE).toBe("ne");
      expect(OpCode.LT).toBe("lt");
      expect(OpCode.LE).toBe("le");
      expect(OpCode.GT).toBe("gt");
      expect(OpCode.GE).toBe("ge");
      expect(OpCode.AND).toBe("and");
      expect(OpCode.OR).toBe("or");
      expect(OpCode.NOT).toBe("not");
      expect(OpCode.JUMP).toBe("jmp");
      expect(OpCode.JUMP_IF).toBe("jmp_if");
      expect(OpCode.JUMP_IF_FALSE).toBe("jmp_if_not");
      expect(OpCode.CALL).toBe("call");
      expect(OpCode.RETURN).toBe("ret");
      expect(OpCode.THROW).toBe("throw");
      expect(OpCode.TRY_CATCH).toBe("try_begin");
      expect(OpCode.FINALLY).toBe("try_end");
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
      await expect(new Interpreter(empty).runProcedure(0, [])).rejects.toMatchObject({
        name: "InterpreterError",
        message: "Stack underflow on pop",
        op: "pop",
        pc: 0,
      });
    });
  });

  describe("ADD / SUB / MUL / DIV", () => {
    it("ADD, SUB, MUL, DIV по операндам; div по нулю → InterpreterError", async () => {
      const sum = tinyMod(
        [
          { op: OpCode.PUSH, type: "i32", k: 0 } as RawInstruction,
          { op: OpCode.PUSH, type: "i32", k: 1 } as RawInstruction,
          { op: OpCode.ADD } as RawInstruction,
        ],
        [10, 3],
      );
      expect(await new Interpreter(sum).runProcedure(0, [])).toBe(13);

      const diff = tinyMod(
        [
          { op: OpCode.PUSH, type: "i32", k: 0 } as RawInstruction,
          { op: OpCode.PUSH, type: "i32", k: 1 } as RawInstruction,
          { op: OpCode.SUB } as RawInstruction,
        ],
        [10, 3],
      );
      expect(await new Interpreter(diff).runProcedure(0, [])).toBe(7);

      const prod = tinyMod(
        [
          { op: OpCode.PUSH, type: "i32", k: 0 } as RawInstruction,
          { op: OpCode.PUSH, type: "i32", k: 1 } as RawInstruction,
          { op: OpCode.MUL } as RawInstruction,
        ],
        [4, 5],
      );
      expect(await new Interpreter(prod).runProcedure(0, [])).toBe(20);

      const quot = tinyMod(
        [
          { op: OpCode.PUSH, type: "i32", k: 0 } as RawInstruction,
          { op: OpCode.PUSH, type: "i32", k: 1 } as RawInstruction,
          { op: OpCode.DIV } as RawInstruction,
        ],
        [20, 4],
      );
      expect(await new Interpreter(quot).runProcedure(0, [])).toBe(5);

      const divZero = tinyMod(
        [
          { op: OpCode.PUSH, type: "i32", k: 0 } as RawInstruction,
          { op: OpCode.PUSH, type: "i32", k: 1 } as RawInstruction,
          { op: OpCode.DIV } as RawInstruction,
        ],
        [1, 0],
      );
      await expect(new Interpreter(divZero).runProcedure(0, [])).rejects.toMatchObject({
        name: "InterpreterError",
        message: "Division by zero",
        op: "div",
        pc: 2,
      });
    });

    it("div: нулевое делимое при ненулевом делителе → 0", async () => {
      const m = tinyMod(
        [
          { op: OpCode.PUSH, type: "i32", k: 0 } as RawInstruction,
          { op: OpCode.PUSH, type: "i32", k: 1 } as RawInstruction,
          { op: OpCode.DIV } as RawInstruction,
        ],
        [0, 7],
      );
      expect(await new Interpreter(m).runProcedure(0, [])).toBe(0);
    });

    it("div: дробное частное согласовано с vm/interpreter.test (7/2=3.5)", async () => {
      const m = tinyMod(
        [
          { op: OpCode.PUSH, type: "i32", k: 0 } as RawInstruction,
          { op: OpCode.PUSH, type: "i32", k: 1 } as RawInstruction,
          { op: OpCode.DIV } as RawInstruction,
        ],
        [7, 2],
      );
      expect(await new Interpreter(m).runProcedure(0, [])).toBe(3.5);
    });

    it("div: отрицательные операнды (как целочисленное деление со знаком в JS)", async () => {
      const neg1 = tinyMod(
        [
          { op: OpCode.PUSH, type: "i32", k: 0 } as RawInstruction,
          { op: OpCode.PUSH, type: "i32", k: 1 } as RawInstruction,
          { op: OpCode.DIV } as RawInstruction,
        ],
        [-15, 3],
      );
      expect(await new Interpreter(neg1).runProcedure(0, [])).toBe(-5);
      const neg2 = tinyMod(
        [
          { op: OpCode.PUSH, type: "i32", k: 0 } as RawInstruction,
          { op: OpCode.PUSH, type: "i32", k: 1 } as RawInstruction,
          { op: OpCode.DIV } as RawInstruction,
        ],
        [15, -3],
      );
      expect(await new Interpreter(neg2).runProcedure(0, [])).toBe(-5);
    });

    it("div: 0/0 → Division by zero (делитель ноль, тот же контракт)", async () => {
      const m = tinyMod(
        [
          { op: OpCode.PUSH, type: "i32", k: 0 } as RawInstruction,
          { op: OpCode.PUSH, type: "i32", k: 1 } as RawInstruction,
          { op: OpCode.DIV } as RawInstruction,
        ],
        [0, 0],
      );
      await expect(new Interpreter(m).runProcedure(0, [])).rejects.toMatchObject({
        name: "InterpreterError",
        message: "Division by zero",
        op: "div",
        pc: 2,
      });
    });

    it("div: делитель −0 трактуется как ноль → Division by zero", async () => {
      const m = tinyMod(
        [
          { op: OpCode.PUSH, type: "i32", k: 0 } as RawInstruction,
          { op: OpCode.PUSH, type: "i32", k: 1 } as RawInstruction,
          { op: OpCode.DIV } as RawInstruction,
        ],
        [1, -0],
      );
      await expect(new Interpreter(m).runProcedure(0, [])).rejects.toMatchObject({
        name: "InterpreterError",
        message: "Division by zero",
        op: "div",
        pc: 2,
      });
    });

    it("try_begin не перехватывает Division by zero (параллельно vm.test для rem)", async () => {
      const m: OsVbcModule = {
        version: 1,
        moduleName: "t_div_try",
        constants: [5, 0, 7],
        procedures: [{ name: "main", codeOffset: 0, argc: 0, localsCount: 0 }],
        code: [
          { op: OpCode.TRY_CATCH, off: 5 } as RawInstruction,
          { op: OpCode.PUSH, type: "i32", k: 0 } as RawInstruction,
          { op: OpCode.PUSH, type: "i32", k: 1 } as RawInstruction,
          { op: OpCode.DIV } as RawInstruction,
          { op: OpCode.FINALLY } as RawInstruction,
          { op: OpCode.PUSH, type: "i32", k: 2 } as RawInstruction,
          { op: OpCode.RETURN } as RawInstruction,
        ],
      };
      await expect(new Interpreter(m).runProcedure(0, [])).rejects.toMatchObject({
        name: "InterpreterError",
        message: "Division by zero",
        op: "div",
      });
    });

    it("mul: переполнение в IEEE double → Infinity без throw (контракт JS в интерпретации)", async () => {
      const m = tinyMod(
        [
          { op: OpCode.PUSH, type: "i32", k: 0 } as RawInstruction,
          { op: OpCode.PUSH, type: "i32", k: 1 } as RawInstruction,
          { op: OpCode.MUL } as RawInstruction,
        ],
        [1e200, 1e200],
      );
      expect(await new Interpreter(m).runProcedure(0, [])).toBe(Infinity);
    });

    it("неверный op: InterpreterError с message, pc и полем op (vm-crash контракт)", async () => {
      const badOp = "unknown_opcode_for_test" as RawInstruction["op"];
      const m = tinyMod([{ op: badOp } as RawInstruction]);
      await expect(new Interpreter(m).runProcedure(0, [])).rejects.toMatchObject({
        name: "InterpreterError",
        message: `Unknown op: ${badOp}`,
        op: badOp,
        pc: 0,
      });
    });
  });

  describe("EQ / LT / GT", () => {
    it("равенство и порядок для чисел", async () => {
      const eqTrue = tinyMod(
        [
          { op: OpCode.PUSH, type: "i32", k: 0 } as RawInstruction,
          { op: OpCode.PUSH, type: "i32", k: 1 } as RawInstruction,
          { op: OpCode.EQ } as RawInstruction,
        ],
        [2, 2],
      );
      expect(await new Interpreter(eqTrue).runProcedure(0, [])).toBe(true);

      const eqFalse = tinyMod(
        [
          { op: OpCode.PUSH, type: "i32", k: 0 } as RawInstruction,
          { op: OpCode.PUSH, type: "i32", k: 1 } as RawInstruction,
          { op: OpCode.EQ } as RawInstruction,
        ],
        [2, 3],
      );
      expect(await new Interpreter(eqFalse).runProcedure(0, [])).toBe(false);

      const lt = tinyMod(
        [
          { op: OpCode.PUSH, type: "i32", k: 0 } as RawInstruction,
          { op: OpCode.PUSH, type: "i32", k: 1 } as RawInstruction,
          { op: OpCode.LT } as RawInstruction,
        ],
        [1, 5],
      );
      expect(await new Interpreter(lt).runProcedure(0, [])).toBe(true);

      const ltFalse = tinyMod(
        [
          { op: OpCode.PUSH, type: "i32", k: 0 } as RawInstruction,
          { op: OpCode.PUSH, type: "i32", k: 1 } as RawInstruction,
          { op: OpCode.LT } as RawInstruction,
        ],
        [5, 1],
      );
      expect(await new Interpreter(ltFalse).runProcedure(0, [])).toBe(false);

      const gt = tinyMod(
        [
          { op: OpCode.PUSH, type: "i32", k: 0 } as RawInstruction,
          { op: OpCode.PUSH, type: "i32", k: 1 } as RawInstruction,
          { op: OpCode.GT } as RawInstruction,
        ],
        [3, 1],
      );
      expect(await new Interpreter(gt).runProcedure(0, [])).toBe(true);

      const gtFalse = tinyMod(
        [
          { op: OpCode.PUSH, type: "i32", k: 0 } as RawInstruction,
          { op: OpCode.PUSH, type: "i32", k: 1 } as RawInstruction,
          { op: OpCode.GT } as RawInstruction,
        ],
        [1, 3],
      );
      expect(await new Interpreter(gtFalse).runProcedure(0, [])).toBe(false);
    });
  });

  describe("logical AND / OR / NOT", () => {
    it("and / or / not на булевых константах", async () => {
      const andTrue = tinyMod(
        [
          { op: "const.true" } as RawInstruction,
          { op: "const.true" } as RawInstruction,
          { op: OpCode.AND } as RawInstruction,
        ],
      );
      expect(await new Interpreter(andTrue).runProcedure(0, [])).toBe(true);

      const andFalse = tinyMod(
        [
          { op: "const.true" } as RawInstruction,
          { op: "const.false" } as RawInstruction,
          { op: OpCode.AND } as RawInstruction,
        ],
      );
      expect(await new Interpreter(andFalse).runProcedure(0, [])).toBe(false);

      const orTrue = tinyMod(
        [
          { op: "const.false" } as RawInstruction,
          { op: "const.true" } as RawInstruction,
          { op: OpCode.OR } as RawInstruction,
        ],
      );
      expect(await new Interpreter(orTrue).runProcedure(0, [])).toBe(true);

      const orFalse = tinyMod(
        [
          { op: "const.false" } as RawInstruction,
          { op: "const.false" } as RawInstruction,
          { op: OpCode.OR } as RawInstruction,
        ],
      );
      expect(await new Interpreter(orFalse).runProcedure(0, [])).toBe(false);

      const notTrue = tinyMod([{ op: "const.true" } as RawInstruction, { op: OpCode.NOT } as RawInstruction]);
      expect(await new Interpreter(notTrue).runProcedure(0, [])).toBe(false);

      const notFalse = tinyMod([{ op: "const.false" } as RawInstruction, { op: OpCode.NOT } as RawInstruction]);
      expect(await new Interpreter(notFalse).runProcedure(0, [])).toBe(true);
    });
  });

  describe("JUMP / JUMP_IF_FALSE", () => {
    it("jmp: безусловный переход пропускает инструкции", async () => {
      const skipMid = tinyMod(
        [
          { op: OpCode.JUMP, off: 2 } as RawInstruction,
          { op: OpCode.PUSH, type: "i32", k: 0 } as RawInstruction,
          { op: OpCode.PUSH, type: "i32", k: 1 } as RawInstruction,
        ],
        [111, 999],
      );
      expect(await new Interpreter(skipMid).runProcedure(0, [])).toBe(999);
    });

    it("jmp_if_not: при falsy переход на off (ветка catch)", async () => {
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
    });

    it("jmp_if_not: при truthy следующие инструкции выполняются без прыжка", async () => {
      const ifTrueFallThrough = tinyMod(
        [
          { op: "const.true" } as RawInstruction,
          { op: OpCode.JUMP_IF_FALSE, off: 5 } as RawInstruction,
          { op: OpCode.PUSH, type: "i32", k: 0 } as RawInstruction,
          { op: OpCode.PUSH, type: "i32", k: 1 } as RawInstruction,
          { op: OpCode.JUMP, off: 6 } as RawInstruction,
          { op: OpCode.PUSH, type: "i32", k: 2 } as RawInstruction,
        ],
        [111, 999, 77],
      );
      expect(await new Interpreter(ifTrueFallThrough).runProcedure(0, [])).toBe(999);
    });
  });

  describe("CALL / RETURN и фреймы", () => {
    it("call передаёт аргументы в локали callee; ret возвращает значение вызывающему кадру", async () => {
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
      const ip = new Interpreter(callMod);
      expect(await ip.runProcedure(0, [])).toBe(7);
      expect(ip.exceptionHandlers.length).toBe(0);
    });
  });

  describe("THROW и обработчики", () => {
    it("try_begin: исключение ловится, значение попадает в catch (local.set)", async () => {
      const m: OsVbcModule = {
        version: 1,
        moduleName: "t_try",
        constants: ["err", 99],
        procedures: [{ name: "main", codeOffset: 0, argc: 0, localsCount: 1 }],
        code: [
          { op: OpCode.TRY_CATCH, off: 5 } as RawInstruction,
          { op: OpCode.PUSH, type: "str", k: 0 } as RawInstruction,
          { op: OpCode.THROW } as RawInstruction,
          { op: OpCode.FINALLY } as RawInstruction,
          { op: OpCode.JUMP, off: 8 } as RawInstruction,
          { op: "local.set", i: 0 } as RawInstruction,
          { op: OpCode.PUSH, type: "i32", k: 1 } as RawInstruction,
          { op: OpCode.RETURN } as RawInstruction,
        ],
      };
      const ip = new Interpreter(m);
      expect(await ip.runProcedure(0, [])).toBe(99);
      expect(ip.exceptionHandlers.length).toBe(0);
    });

    it("try_end снимает обработчик при успешном проходе без throw", async () => {
      const m: OsVbcModule = {
        version: 1,
        moduleName: "t_try_ok",
        constants: [42],
        procedures: [{ name: "main", codeOffset: 0, argc: 0, localsCount: 0 }],
        code: [
          { op: OpCode.TRY_CATCH, off: 4 } as RawInstruction,
          { op: OpCode.PUSH, type: "i32", k: 0 } as RawInstruction,
          { op: OpCode.FINALLY } as RawInstruction,
          { op: OpCode.RETURN } as RawInstruction,
        ],
      };
      const ip = new Interpreter(m);
      expect(await ip.runProcedure(0, [])).toBe(42);
      expect(ip.exceptionHandlers.length).toBe(0);
    });

    it("необработанный THROW → InterpreterError (сообщение, op, pc)", async () => {
      const m = tinyMod([{ op: OpCode.PUSH, type: "str", k: 0 } as RawInstruction, { op: OpCode.THROW } as RawInstruction], ["x"]);
      await expect(new Interpreter(m).runProcedure(0, [])).rejects.toMatchObject({
        name: "InterpreterError",
        message: "Необработанное исключение: x",
        op: "throw",
        pc: 1,
      });
    });

    it("try_begin фиксирует глубину кадров; throw подрезает лишние call-фреймы до catch", async () => {
      const m: OsVbcModule = {
        version: 1,
        moduleName: "t_throw_frames",
        constants: ["boom", 42],
        procedures: [
          { name: "main", codeOffset: 0, argc: 0, localsCount: 0 },
          { name: "inner", codeOffset: 3, argc: 0, localsCount: 0 },
        ],
        code: [
          { op: OpCode.TRY_CATCH, off: 5 } as RawInstruction,
          { op: OpCode.CALL, fi: 1 } as RawInstruction,
          { op: OpCode.RETURN } as RawInstruction,
          { op: OpCode.PUSH, type: "str", k: 0 } as RawInstruction,
          { op: OpCode.THROW } as RawInstruction,
          { op: OpCode.PUSH, type: "i32", k: 1 } as RawInstruction,
          { op: OpCode.RETURN } as RawInstruction,
        ],
      };
      const ip = new Interpreter(m);
      expect(await ip.runProcedure(0, [])).toBe(42);
      expect(ip.exceptionHandlers.length).toBe(0);
    });
  });

  describe("Вложенные вызовы", () => {
    it("цепочка main → L1 → L2: каждый call создаёт свой фрейм локалей, ret сходит по стеку вызовов", async () => {
      const nested: OsVbcModule = {
        version: 1,
        moduleName: "t_nested",
        constants: [5, 2],
        procedures: [
          { name: "main", codeOffset: 0, argc: 0, localsCount: 0 },
          { name: "L1", codeOffset: 4, argc: 2, localsCount: 2 },
          { name: "L2", codeOffset: 8, argc: 2, localsCount: 2 },
        ],
        code: [
          { op: OpCode.PUSH, type: "i32", k: 0 } as RawInstruction,
          { op: OpCode.PUSH, type: "i32", k: 1 } as RawInstruction,
          { op: OpCode.CALL, fi: 1 } as RawInstruction,
          { op: OpCode.RETURN } as RawInstruction,
          { op: "local.get", i: 0 } as RawInstruction,
          { op: "local.get", i: 1 } as RawInstruction,
          { op: OpCode.CALL, fi: 2 } as RawInstruction,
          { op: OpCode.RETURN } as RawInstruction,
          { op: "local.get", i: 0 } as RawInstruction,
          { op: "local.get", i: 1 } as RawInstruction,
          { op: OpCode.MUL } as RawInstruction,
          { op: OpCode.RETURN } as RawInstruction,
        ],
      };
      expect(await new Interpreter(nested).runProcedure(0, [])).toBe(10);
    });
  });

  it("VLIW: throw в слотах переводит PC на catch", async () => {
    const m: OsVbcModule = {
      version: 1,
      moduleName: "t_vliw_throw",
      constants: ["e"],
      procedures: [{ name: "main", codeOffset: 0, argc: 0, localsCount: 1 }],
      code: [
        {
          packet: true,
          slots: [
            { op: OpCode.TRY_CATCH, off: 1 } as RawInstruction,
            { op: OpCode.PUSH, type: "str", k: 0 } as RawInstruction,
            { op: OpCode.THROW } as RawInstruction,
          ],
        },
        { op: "local.set", i: 0 } as RawInstruction,
        { op: "local.get", i: 0 } as RawInstruction,
        { op: "ret" } as RawInstruction,
      ],
    };
    const vm = new VM(m, { maxSteps: 500 });
    expect(await vm.runProcedure(0, [])).toBe("e");
  });
});
