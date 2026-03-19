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

  function buildLocals(proc: Procedure): Map<string, number> {
    const locals = new Map<string, number>();
    let forCounter = 0;
    let arrLiteralCounter = 0;
    proc.params.forEach((p, i) => locals.set(p, i));
    function scanExpr(expr: Expr): void {
      if (expr.kind === "объект") {
        for (const { value } of expr.entries) scanExpr(value);
        return;
      }
      if (expr.kind === "поле") {
        scanExpr(expr.object);
        return;
      }
      if (expr.kind === "массив") {
        if (!locals.has(`__arr_literal_${arrLiteralCounter}`))
          locals.set(`__arr_literal_${arrLiteralCounter}`, locals.size);
        arrLiteralCounter++;
        for (const el of expr.elements) scanExpr(el);
        return;
      }
      if (expr.kind === "бинарное") {
        scanExpr(expr.left);
        scanExpr(expr.right);
        return;
      }
      if (expr.kind === "унарное") scanExpr(expr.arg);
      if (expr.kind === "вызов") for (const a of expr.args) scanExpr(a);
    }
    function scan(stmts: Stmt[]): void {
      for (const s of stmts) {
        if (s.kind === "пусть" && !locals.has(s.name)) {
          locals.set(s.name, locals.size);
          scanExpr(s.init);
        }
        if (s.kind === "присвоить") scanExpr(s.value);
        if (s.kind === "выражение") scanExpr(s.expr);
        if (s.kind === "если") {
          scanExpr(s.condition);
          scan(s.body);
          if (s.elseIfClauses) {
            for (const c of s.elseIfClauses) {
              scanExpr(c.condition);
              scan(c.body);
            }
          }
          if (s.elseBody) scan(s.elseBody);
        }
        if (s.kind === "пока") {
          scanExpr(s.condition);
          scan(s.body);
        }
        if (s.kind === "для_каждого") {
          if (!locals.has(s.variable)) locals.set(s.variable, locals.size);
          const arrKey = `__for_arr_${forCounter}`;
          const idxKey = `__for_idx_${forCounter}`;
          if (!locals.has(arrKey)) locals.set(arrKey, locals.size);
          if (!locals.has(idxKey)) locals.set(idxKey, locals.size);
          forCounter++;
          scanExpr(s.collection);
          scan(s.body);
        }
        if (s.kind === "цикл") scan(s.body);
        if (s.kind === "вернуть" && s.value) scanExpr(s.value);
        if (s.kind === "поле_присвоить") scanExpr(s.value);
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
    let emitArrLiteralCounter = 0;

    function emitExpr(expr: Expr, l: Map<string, number>): void {
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
          const i = l.get(expr.name);
          if (i === undefined) throw new Error(`Неизвестная переменная: ${expr.name}`);
          emit({ op: "local.get", i } as RawInstruction);
          break;
        }
        case "бинарное": {
          if (expr.op === "и") {
            emitExpr(expr.left, l);
            const patchJmpIfNot = code.length;
            emit({ op: "jmp_if_not", off: 0 } as RawInstruction);
            emitExpr(expr.right, l);
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
            emitExpr(expr.left, l);
            const patchJmpIf = code.length;
            emit({ op: "jmp_if", off: 0 } as RawInstruction);
            emitExpr(expr.right, l);
            const patchJmpEnd = code.length;
            emit({ op: "jmp", off: 0 } as RawInstruction);
            const shortCircuitLabel = code.length;
            emit({ op: "const.true" } as RawInstruction);
            const endOr = code.length;
            (code[patchJmpIf] as { off: number }).off = shortCircuitLabel;
            (code[patchJmpEnd] as { off: number }).off = endOr;
            break;
          }
          emitExpr(expr.left, l);
          emitExpr(expr.right, l);
          emit({ op: BINARY_OP[expr.op] } as RawInstruction);
          break;
        }
        case "унарное":
          if (expr.op === "не") {
            const arg = expr.arg;
            if (arg.kind === "пусто" || arg.kind === "число" || arg.kind === "строка") {
              log.info(`"не" с не-булевым операндом (${arg.kind}) — семантика: строгое сравнение с false`);
            }
            emitExpr(expr.arg, l);
            emit({ op: "const.false" } as RawInstruction);
            emit({ op: "eq" } as RawInstruction);
          }
          break;
        case "массив": {
          const slotKey = `__arr_literal_${emitArrLiteralCounter++}`;
          const arrSlot = l.get(slotKey);
          if (arrSlot === undefined) throw new Error(`Нет слота для массива: ${slotKey}`);
          emit({ op: "invoke", name: "система.массив.создать" } as RawInstruction);
          emit({ op: "local.set", i: arrSlot } as RawInstruction);
          for (const element of expr.elements) {
            emit({ op: "local.get", i: arrSlot } as RawInstruction);
            emitExpr(element, l);
            emit({ op: "invoke", name: "система.массив.добавить" } as RawInstruction);
          }
          emit({ op: "local.get", i: arrSlot } as RawInstruction);
          break;
        }
        case "объект": {
          emit({ op: "obj.new" } as RawInstruction);
          for (const { key, value } of expr.entries) {
            emit({ op: "dup" } as RawInstruction);
            const k = constIndex(key);
            emit({ op: "const", type: "str", k } as RawInstruction);
            emitExpr(value, l);
            emit({ op: "obj.set" } as RawInstruction);
          }
          break;
        }
        case "поле": {
          emitExpr(expr.object, l);
          const k = constIndex(expr.field);
          emit({ op: "const", type: "str", k } as RawInstruction);
          emit({ op: "obj.get" } as RawInstruction);
          break;
        }
        case "вызов": {
          for (const arg of expr.args) emitExpr(arg, l);
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
        case "поле_присвоить": {
          const objIdx = locals.get(s.object);
          if (objIdx === undefined) {
            throw new Error(`Переменная "${s.object}" не объявлена`);
          }
          emit({ op: "local.get", i: objIdx } as RawInstruction);
          const k = constIndex(s.field);
          emit({ op: "const", type: "str", k } as RawInstruction);
          emitExpr(s.value, locals);
          emit({ op: "obj.set" } as RawInstruction);
          emit({ op: "local.set", i: objIdx } as RawInstruction);
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
