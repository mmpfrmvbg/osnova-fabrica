/**
 * Генерация байткода Основа MVP: AST → OsVbcModule.
 * Stack Convention v0.1: push arg0, push arg1, op → result on stack.
 */

import type { OsVbcModule, RawInstruction } from "../runtime/vm/bytecode";
import type { Module, Procedure, Stmt, Expr } from "./ast";
import { logger } from "../logger";

const log = logger("codegen");

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
          // [left, jmp_if_not shortCircuit, right, jmp endAnd, shortCircuit: const.false, endAnd:]
          emitExpr(expr.left, locals);
          const patchJmpIfNot = code.length;
          emit({ op: "jmp_if_not", off: 0 } as RawInstruction);
          emitExpr(expr.right, locals);
          const patchJmpEnd = code.length;
          emit({ op: "jmp", off: 0 } as RawInstruction);
          const shortCircuitLabel = code.length;
          emit({ op: "const.false" } as RawInstruction);
          const endAnd = code.length;
          (code[patchJmpIfNot] as { off: number }).off = shortCircuitLabel;
          (code[patchJmpEnd] as { off: number }).off = endAnd;
          break;
        }
        if (expr.op === "или") {
          // [left, jmp_if shortCircuit, right, jmp endOr, shortCircuit: const.true, endOr:]
          emitExpr(expr.left, locals);
          const patchJmpIf = code.length;
          emit({ op: "jmp_if", off: 0 } as RawInstruction);
          emitExpr(expr.right, locals);
          const patchJmpEnd = code.length;
          emit({ op: "jmp", off: 0 } as RawInstruction);
          const shortCircuitLabel = code.length;
          emit({ op: "const.true" } as RawInstruction);
          const endOr = code.length;
          (code[patchJmpIf] as { off: number }).off = shortCircuitLabel;
          (code[patchJmpEnd] as { off: number }).off = endOr;
          break;
        }
        emitExpr(expr.left, locals);
        emitExpr(expr.right, locals);
        emit({ op: BINARY_OP[expr.op] } as RawInstruction);
        break;
      }
      case "унарное":
        if (expr.op === "не") {
          const arg = expr.arg;
          if (arg.kind === "пусто" || arg.kind === "число" || arg.kind === "строка") {
            log.info(`"не" с не-булевым операндом (${arg.kind}) — семантика: строгое сравнение с false`);
          }
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
    let forCounter = 0;
    proc.params.forEach((p, i) => locals.set(p, i));
    function scan(stmts: Stmt[]): void {
      for (const s of stmts) {
        if (s.kind === "пусть" && !locals.has(s.name)) locals.set(s.name, locals.size);
        if (s.kind === "присвоить") { /* не добавляем в locals — требуется пусть, ошибка в emitStmt */ }
        if (s.kind === "если") {
          scan(s.body);
          if (s.elseIfClauses) for (const c of s.elseIfClauses) scan(c.body);
          if (s.elseBody) scan(s.elseBody);
        }
        if (s.kind === "пока") scan(s.body);
        if (s.kind === "для_каждого") {
          if (!locals.has(s.variable)) locals.set(s.variable, locals.size);
          const arrKey = `__for_arr_${forCounter}`;
          const idxKey = `__for_idx_${forCounter}`;
          if (!locals.has(arrKey)) locals.set(arrKey, locals.size);
          if (!locals.has(idxKey)) locals.set(idxKey, locals.size);
          forCounter++;
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
    let emitForCounter = 0;

    function emitStmt(s: Stmt): void {
      switch (s.kind) {
        case "пусть":
          emitExpr(s.init, locals);
          emit({ op: "local.set", i: locals.get(s.name)! } as RawInstruction);
          break;
        case "присвоить": {
          const slot = locals.get(s.name);
          if (slot === undefined) {
            throw new Error(`Переменная "${s.name}" не объявлена через пусть`);
          }
          emitExpr(s.value, locals);
          emit({ op: "local.set", i: slot } as RawInstruction);
          break;
        }
        case "выражение":
          emitExpr(s.expr, locals);
          break;
        case "если": {
          emitExpr(s.condition, locals);
          const patchJmpIfFalse = code.length;
          emit({ op: "jmp_if_not", off: 0 } as RawInstruction);
          for (const b of s.body) emitStmt(b);
          const hasElsePart =
            (s.elseIfClauses && s.elseIfClauses.length > 0) ||
            (s.elseBody && s.elseBody.length > 0);
          let patchJmpSkip: number | null = null;
          if (hasElsePart) {
            patchJmpSkip = code.length;
            emit({ op: "jmp", off: 0 } as RawInstruction);
          }
          const patchesToEnd: number[] = [];
          if (s.elseIfClauses && s.elseIfClauses.length > 0) {
            let nextTarget = code.length;
            (code[patchJmpIfFalse] as { off: number }).off = nextTarget;
            for (const clause of s.elseIfClauses) {
              emitExpr(clause.condition, locals);
              const patchClauseJmp = code.length;
              emit({ op: "jmp_if_not", off: 0 } as RawInstruction);
              for (const b of clause.body) emitStmt(b);
              patchesToEnd.push(code.length);
              emit({ op: "jmp", off: 0 } as RawInstruction);
              nextTarget = code.length;
              (code[patchClauseJmp] as { off: number }).off = nextTarget;
            }
            if (s.elseBody && s.elseBody.length > 0) {
              for (const b of s.elseBody) emitStmt(b);
            }
          } else if (s.elseBody && s.elseBody.length > 0) {
            (code[patchJmpIfFalse] as { off: number }).off = code.length;
            for (const b of s.elseBody) emitStmt(b);
          } else {
            (code[patchJmpIfFalse] as { off: number }).off = code.length;
          }
          const endIf = code.length;
          if (patchJmpSkip !== null)
            (code[patchJmpSkip] as { off: number }).off = endIf;
          for (const p of patchesToEnd)
            (code[p] as { off: number }).off = endIf;
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
          const depth = emitForCounter++;
          const arrSlot = locals.get(`__for_arr_${depth}`)!;
          const idxSlot = locals.get(`__for_idx_${depth}`)!;
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
