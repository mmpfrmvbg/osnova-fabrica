/**
 * Генерация байткода Основа MVP: AST → OsVbcModule.
 * Stack Convention v0.1: push arg0, push arg1, op → result on stack.
 */

import type { OsVbcModule, RawInstruction } from "../osnova-runtime/vm/bytecode";
import type { Module, Procedure, Stmt, Expr } from "./ast";

const BINARY_OP: Record<string, RawInstruction["op"]> = {
  "+": "add",
  "-": "sub",
  "*": "mul",
  "/": "div",
  "%": "rem",
  "==": "eq",
  "!=": "ne",
  "<": "lt",
  "<=": "le",
  ">": "gt",
  ">=": "ge",
};

export function compile(ast: Module): OsVbcModule {
  const constants: unknown[] = [];
  const code: RawInstruction[] = [];
  const procedures: OsVbcModule["procedures"] = [];
  const procedureIndex = new Map<string, number>();

  function constIndex(value: unknown): number {
    let i = constants.indexOf(value);
    if (i < 0) {
      i = constants.length;
      constants.push(value);
    }
    return i;
  }

  function constType(value: unknown): "i32" | "f64" | "str" | "bool" | "null" {
    if (typeof value === "number") return Number.isInteger(value) ? "i32" : "f64";
    if (typeof value === "string") return "str";
    if (typeof value === "boolean") return "bool";
    return "null";
  }

  function emit(ins: RawInstruction): void {
    code.push(ins);
  }

  function emitExpr(expr: Expr, locals: Map<string, number>): void {
    switch (expr.kind) {
      case "число": {
        const k = constIndex(expr.value);
        emit({ op: "const", type: constType(expr.value), k } as RawInstruction);
        break;
      }
      case "строка": {
        const k = constIndex(expr.value);
        emit({ op: "const", type: "str", k } as RawInstruction);
        break;
      }
      case "булево":
        emit((expr.value ? { op: "const.true" } : { op: "const.false" }) as RawInstruction);
        break;
      case "пусто":
        emit({ op: "const.null" } as RawInstruction);
        break;
      case "переменная": {
        const i = locals.get(expr.name);
        if (i === undefined) throw new Error(`Неизвестная переменная: ${expr.name}`);
        emit({ op: "local.get", i } as RawInstruction);
        break;
      }
      case "бинарное": {
        if (expr.op === "и") {
          emitExpr(expr.left, locals);
          const patchSkip = code.length;
          emit({ op: "jmp_if_not", off: 0 } as RawInstruction);
          emitExpr(expr.right, locals);
          (code[patchSkip] as { off: number }).off = code.length;
          break;
        }
        if (expr.op === "или") {
          emitExpr(expr.left, locals);
          const patchJmpIf = code.length;
          emit({ op: "jmp_if", off: 0 } as RawInstruction);
          emitExpr(expr.right, locals);
          const patchJmpPastRight = code.length;
          emit({ op: "jmp", off: 0 } as RawInstruction);
          const skipToTrue = code.length;
          emit({ op: "const.true" } as RawInstruction);
          const endOr = code.length;
          (code[patchJmpIf] as { off: number }).off = skipToTrue;
          (code[patchJmpPastRight] as { off: number }).off = endOr;
          break;
        }
        emitExpr(expr.left, locals);
        emitExpr(expr.right, locals);
        emit({ op: BINARY_OP[expr.op] } as RawInstruction);
        break;
      }
      case "унарное":
        if (expr.op === "не") {
          emitExpr(expr.arg, locals);
          emit({ op: "const.false" } as RawInstruction);
          emit({ op: "eq" } as RawInstruction);
        }
        break;
      case "вызов": {
        for (const arg of expr.args) emitExpr(arg, locals);
        if (expr.name.includes(".")) {
          emit({ op: "invoke", name: expr.name } as RawInstruction);
        } else {
          const fi = procedureIndex.get(expr.name);
          if (fi === undefined) throw new Error(`Неизвестная процедура: ${expr.name}`);
          emit({ op: "call", fi } as RawInstruction);
        }
        break;
      }
    }
  }

  function buildLocals(proc: Procedure): Map<string, number> {
    const locals = new Map<string, number>();
    proc.params.forEach((p, i) => locals.set(p, i));
    function scan(stmts: Stmt[]): void {
      for (const s of stmts) {
        if (s.kind === "пусть" && !locals.has(s.name)) locals.set(s.name, locals.size);
        if (s.kind === "присвоить" && !locals.has(s.name)) locals.set(s.name, locals.size);
        if (s.kind === "если") {
          scan(s.body);
          if (s.elseBody) scan(s.elseBody);
        }
        if (s.kind === "пока") scan(s.body);
        if (s.kind === "для_каждого") {
          if (!locals.has(s.variable)) locals.set(s.variable, locals.size);
          if (!locals.has("__for_arr")) locals.set("__for_arr", locals.size);
          if (!locals.has("__for_idx")) locals.set("__for_idx", locals.size);
          scan(s.body);
        }
        if (s.kind === "цикл") scan(s.body);
      }
    }
    scan(proc.body);
    return locals;
  }

  ast.procedures.forEach((p, fi) => procedureIndex.set(p.name, fi));

  for (const proc of ast.procedures) {
    const codeOffset = code.length;
    const locals = buildLocals(proc);
    const localsCount = Math.max(proc.params.length, locals.size);

    function emitStmt(s: Stmt): void {
      switch (s.kind) {
        case "пусть":
          emitExpr(s.init, locals);
          emit({ op: "local.set", i: locals.get(s.name)! } as RawInstruction);
          break;
        case "присвоить":
          emitExpr(s.value, locals);
          emit({ op: "local.set", i: locals.get(s.name)! } as RawInstruction);
          break;
        case "выражение":
          emitExpr(s.expr, locals);
          break;
        case "если": {
          emitExpr(s.condition, locals);
          const jmpIfFalse = code.length;
          emit({ op: "jmp_if_not", off: 0 } as RawInstruction);
          for (const b of s.body) emitStmt(b);
          if (s.elseBody && s.elseBody.length > 0) {
            const jmpEnd = code.length;
            emit({ op: "jmp", off: 0 } as RawInstruction);
            (code[jmpIfFalse] as { off: number }).off = code.length;
            for (const b of s.elseBody) emitStmt(b);
            (code[jmpEnd] as { off: number }).off = code.length;
          } else {
            (code[jmpIfFalse] as { off: number }).off = code.length;
          }
          break;
        }
        case "пока": {
          const loopStart = code.length;
          emitExpr(s.condition, locals);
          const patchExit = code.length;
          emit({ op: "jmp_if_not", off: 0 } as RawInstruction);
          for (const b of s.body) emitStmt(b);
          emit({ op: "jmp", off: loopStart } as RawInstruction);
          (code[patchExit] as { off: number }).off = code.length;
          break;
        }
        case "для_каждого": {
          const arrSlot = locals.get("__for_arr")!;
          const idxSlot = locals.get("__for_idx")!;
          const varSlot = locals.get(s.variable)!;
          emitExpr(s.collection, locals);
          emit({ op: "local.set", i: arrSlot } as RawInstruction);
          const k0 = constIndex(0);
          emit({ op: "const", type: "i32", k: k0 } as RawInstruction);
          emit({ op: "local.set", i: idxSlot } as RawInstruction);
          const loopStart = code.length;
          emit({ op: "local.get", i: idxSlot } as RawInstruction);
          emit({ op: "local.get", i: arrSlot } as RawInstruction);
          emit({ op: "invoke", name: "система.массив.длина" } as RawInstruction);
          emit({ op: "lt" } as RawInstruction);
          const patchExit = code.length;
          emit({ op: "jmp_if_not", off: 0 } as RawInstruction);
          emit({ op: "local.get", i: arrSlot } as RawInstruction);
          emit({ op: "local.get", i: idxSlot } as RawInstruction);
          emit({ op: "invoke", name: "система.массив.получить" } as RawInstruction);
          emit({ op: "local.set", i: varSlot } as RawInstruction);
          for (const b of s.body) emitStmt(b);
          emit({ op: "local.get", i: idxSlot } as RawInstruction);
          const k1 = constIndex(1);
          emit({ op: "const", type: "i32", k: k1 } as RawInstruction);
          emit({ op: "add" } as RawInstruction);
          emit({ op: "local.set", i: idxSlot } as RawInstruction);
          emit({ op: "jmp", off: loopStart } as RawInstruction);
          (code[patchExit] as { off: number }).off = code.length;
          break;
        }
        case "цикл": {
          const loopStart = code.length;
          for (const b of s.body) emitStmt(b);
          emit({ op: "jmp", off: loopStart } as RawInstruction);
          break;
        }
        case "вернуть":
          if (s.value) emitExpr(s.value, locals);
          else emit({ op: "const.null" } as RawInstruction);
          emit({ op: "ret" } as RawInstruction);
          break;
      }
    }

    for (const s of proc.body) emitStmt(s);
    emit({ op: "ret" } as RawInstruction);

    procedures.push({
      name: proc.name,
      codeOffset,
      argc: proc.params.length,
      localsCount,
    });
  }

  return {
    version: 1,
    moduleName: ast.name,
    constants,
    procedures,
    code,
  };
}
