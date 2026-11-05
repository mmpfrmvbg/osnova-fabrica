/**
 * Генерация байткода Основа MVP: AST → OsVbcModule.
 * Stack Convention v0.1: push arg0, push arg1, op → result on stack.
 */

import type { Op, OsVbcModule, RawInstruction } from "../runtime/vm/bytecode";
import type { Program, Module, Procedure, Stmt, Expr } from "./ast";
import { logger } from "../logger";

const log = logger("codegen");

function assertNever(x: never, ctx: string): never {
  throw new Error(`codegen: непокрытый узел (${ctx})`);
}

/** Значения — только из {@link Op}; иначе VM выдаст Unknown op в interpretInstruction. */
const BINARY_OP: Record<string, Op> = {
  "+": "add",
  "-": "sub",
  "*": "mul",
  "/": "div",
  "%": "rem",
  // БЛОК 2: целочисленное деление — отдельная операция, а не режим `div`:
  // `div` в VM вещественный (`a / b`), `idiv` отсекает к нулю.
  "div": "idiv",
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
    let objLiteralCounter = 0;
    proc.params.forEach((p, i) => locals.set(p, i));
    function scanExpr(expr: Expr): void {
      if (expr.kind === "объект") {
        if (!locals.has(`__obj_literal_${objLiteralCounter}`))
          locals.set(`__obj_literal_${objLiteralCounter}`, locals.size);
        objLiteralCounter++;
        for (const { value } of expr.entries) scanExpr(value);
        return;
      }
      if (expr.kind === "поле") {
        scanExpr(expr.object);
        return;
      }
      if (expr.kind === "вариант") {
        return;
      }
      if (expr.kind === "массив") {
        if (!locals.has(`__arr_literal_${arrLiteralCounter}`))
          locals.set(`__arr_literal_${arrLiteralCounter}`, locals.size);
        arrLiteralCounter++;
        for (const el of expr.elements) scanExpr(el);
        return;
      }
      if (expr.kind === "кортеж") {
        if (!locals.has(`__arr_literal_${arrLiteralCounter}`))
          locals.set(`__arr_literal_${arrLiteralCounter}`, locals.size);
        arrLiteralCounter++;
        for (const el of expr.элементы) scanExpr(el);
        return;
      }
      // ПАРА `Результат<Т, Е>` на ЭТАЛОННОЙ плоскости — блок из двух мест (тег, нагрузка), тот же
      // слот, что у литерала массива. Плоскость ЦЕЛИ пару блоком не строит: там это две клетки
      // канала вызова (§10.2), и расхождение представлений названо, а не спрятано.
      if (expr.kind === "успех" || expr.kind === "неудача") {
        if (!locals.has(`__arr_literal_${arrLiteralCounter}`))
          locals.set(`__arr_literal_${arrLiteralCounter}`, locals.size);
        arrLiteralCounter++;
        scanExpr(expr.значение);
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
        if (s.kind === "распаковать") {
          for (const имя of s.имена) {
            if (!locals.has(имя)) locals.set(имя, locals.size);
          }
          scanExpr(s.значение);
        }
        if (s.kind === "присвоить") scanExpr(s.value);
        if (s.kind === "выражение") scanExpr(s.expr);
        if (s.kind === "если") {
          scanExpr(s.condition);
          scan(s.body);
          if (s.elseIfClauses && s.elseIfClauses.length > 0) {
            for (const c of s.elseIfClauses) {
              scanExpr(c.condition);
              scan(c.body);
            }
          }
          if (s.elseBody) scan(s.elseBody);
        }
        if (s.kind === "когда") {
          scanExpr(s.scrutinee);
          for (const arm of s.arms) {
            scanExpr(arm.variant);
            scan(arm.body);
          }
          if (s.elseBody) scan(s.elseBody);
        }
        if (s.kind === "пока") {
          scanExpr(s.condition);
          scan(s.body);
        }
        if (s.kind === "для_каждого") {
          if (!locals.has(s.item)) locals.set(s.item, locals.size);
          if (s.index && !locals.has(s.index)) locals.set(s.index, locals.size);
          const srcKey = `__forEach_src_${forCounter}`;
          const lenKey = `__forEach_len_${forCounter}`;
          const idxKey = `__forEach_i_${forCounter}`;
          if (!locals.has(srcKey)) locals.set(srcKey, locals.size);
          if (!locals.has(lenKey)) locals.set(lenKey, locals.size);
          if (!locals.has(idxKey)) locals.set(idxKey, locals.size);
          forCounter++;
          scanExpr(s.source);
          scan(s.body);
        }
        if (s.kind === "цикл") scan(s.body);
        if (s.kind === "вернуть" && s.value) scanExpr(s.value);
        if (s.kind === "поле_присвоить") scanExpr(s.value);
        if (s.kind === "выбросить") scanExpr(s.value);
        if (s.kind === "попробовать") {
          if (!locals.has(s.catchVar)) locals.set(s.catchVar, locals.size);
          scan(s.body);
          scan(s.catchBody);
        }
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
    const breakTargets: { patches: number[] }[] = [];
    const continueTargets: { loopStart: number; foreachPatches?: number[] }[] = [];
    let emitForCounter = 0;
    let emitArrLiteralCounter = 0;
    let emitObjLiteralCounter = 0;

    const emitExpr = (expr: Expr, l: Map<string, number>): void => {
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
          const binOp = BINARY_OP[expr.op];
          if (binOp === undefined) {
            throw new Error(`Неподдерживаемый бинарный оператор: ${expr.op}`);
          }
          emit({ op: binOp } as RawInstruction);
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
            break;
          }
          throw new Error("Неподдерживаемый унарный оператор");
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
            // Закон исходника: вызов без использования результата не оставляет значение.
            emit({ op: "pop" } as RawInstruction);
          }
          emit({ op: "local.get", i: arrSlot } as RawInstruction);
          break;
        }
        case "кортеж": {
          const slotKey = `__arr_literal_${emitArrLiteralCounter++}`;
          const slot = l.get(slotKey);
          if (slot === undefined) throw new Error(`Нет слота для кортежа: ${slotKey}`);
          emit({ op: "invoke", name: "система.массив.создать" } as RawInstruction);
          emit({ op: "local.set", i: slot } as RawInstruction);
          for (const el of expr.элементы) {
            emit({ op: "local.get", i: slot } as RawInstruction);
            emitExpr(el, l);
            emit({ op: "invoke", name: "система.массив.добавить" } as RawInstruction);
            emit({ op: "pop" } as RawInstruction);
          }
          emit({ op: "local.get", i: slot } as RawInstruction);
          break;
        }
        // ПАРА `Результат<Т, Е>`: место 0 — ТЕГ (0 = Успех, 1 = Неудача), место 1 — НАГРУЗКА.
        // Тот же блок из двух мест, что у литерала массива/кортежа, поэтому `распаковать` читает
        // её существующей ветвью. Числа тега — i32, а не булево: `если тег == 1` обязано сравнивать
        // ЧИСЛА на обеих плоскостях (у цели булева литерала нет вовсе, `e2kRealRun.ts#literalOf`).
        case "успех":
        case "неудача": {
          const slotKey = `__arr_literal_${emitArrLiteralCounter++}`;
          const slot = l.get(slotKey);
          if (slot === undefined) throw new Error(`Нет слота для пары Результат<>: ${slotKey}`);
          emit({ op: "invoke", name: "система.массив.создать" } as RawInstruction);
          emit({ op: "local.set", i: slot } as RawInstruction);
          const tag = constIndex(expr.kind === "успех" ? 0 : 1);
          for (const значение of [null, expr.значение] as const) {
            emit({ op: "local.get", i: slot } as RawInstruction);
            if (значение === null) {
              emit({ op: "const", type: "i32", k: tag } as RawInstruction);
            } else {
              emitExpr(значение, l);
            }
            emit({ op: "invoke", name: "система.массив.добавить" } as RawInstruction);
            emit({ op: "pop" } as RawInstruction);
          }
          emit({ op: "local.get", i: slot } as RawInstruction);
          break;
        }
        case "объект": {
          const slotKey = `__obj_literal_${emitObjLiteralCounter++}`;
          const objSlot = l.get(slotKey);
          if (objSlot === undefined) throw new Error(`Нет слота для объекта: ${slotKey}`);
          emit({ op: "obj.new" } as RawInstruction);
          emit({ op: "local.set", i: objSlot } as RawInstruction);
          for (const { key, value } of expr.entries) {
            emit({ op: "local.get", i: objSlot } as RawInstruction);
            const k = constIndex(key);
            emit({ op: "const", type: "str", k } as RawInstruction);
            emitExpr(value, l);
            emit({ op: "obj.set" } as RawInstruction);
            emit({ op: "local.set", i: objSlot } as RawInstruction);
          }
          emit({ op: "local.get", i: objSlot } as RawInstruction);
          break;
        }
        case "поле": {
          emitExpr(expr.object, l);
          const k = constIndex(expr.field);
          emit({ op: "const", type: "str", k } as RawInstruction);
          emit({ op: "obj.get" } as RawInstruction);
          break;
        }
        case "вариант": {
          const lit = `${expr.typeName}.${expr.variant}`;
          const k = constIndex(lit);
          emit({ op: "const", type: constType(lit), k } as RawInstruction);
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
        default:
          assertNever(expr, "Expr.emitExpr");
      }
    };

    const emitStmt = (s: Stmt): void => {
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
        case "распаковать": {
          emitExpr(s.значение, locals);
          s.имена.forEach((имя, i) => {
            const slot = locals.get(имя);
            if (slot === undefined) throw new Error(`Переменная "${имя}" не объявлена`);
            emit({ op: "dup" } as RawInstruction);
            const k = constIndex(i);
            emit({ op: "const", type: "i32", k } as RawInstruction);
            emit({ op: "invoke", name: "система.массив.получить" } as RawInstruction);
            emit({ op: "local.set", i: slot } as RawInstruction);
          });
          emit({ op: "pop" } as RawInstruction);
          break;
        }
        case "поле_присвоить": {
          emitExpr(s.object, locals);
          const k = constIndex(s.field);
          emit({ op: "const", type: "str", k } as RawInstruction);
          emitExpr(s.value, locals);
          emit({ op: "obj.set" } as RawInstruction);
          break;
        }
        case "выражение":
          emitExpr(s.expr, locals);
          // Вызов как инструкция: исходник не использует результат — компилятор снимает его.
          if (s.expr.kind === "вызов") {
            emit({ op: "pop" } as RawInstruction);
          }
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
        case "попробовать": {
          const catchSlot = locals.get(s.catchVar);
          if (catchSlot === undefined) {
            throw new Error(`Переменная catch '${s.catchVar}' не объявлена`);
          }
          const patchTryBegin = code.length;
          emit({ op: "try_begin", off: 0 } as RawInstruction);
          for (const b of s.body) emitStmt(b);
          emit({ op: "try_end" } as RawInstruction);
          const patchJmpEnd = code.length;
          emit({ op: "jmp", off: 0 } as RawInstruction);
          const catchLabel = code.length;
          (code[patchTryBegin] as { off: number }).off = catchLabel;
          emit({ op: "local.set", i: catchSlot } as RawInstruction);
          for (const b of s.catchBody) emitStmt(b);
          const endTry = code.length;
          (code[patchJmpEnd] as { off: number }).off = endTry;
          break;
        }
        case "выбросить":
          emitExpr(s.value, locals);
          emit({ op: "throw" } as RawInstruction);
          break;
        case "пока": {
          breakTargets.push({ patches: [] });
          const loopStart = code.length;
          continueTargets.push({ loopStart });
          emitExpr(s.condition, locals);
          const patchExit = code.length;
          emit({ op: "jmp_if_not", off: 0 } as RawInstruction);
          for (const b of s.body) emitStmt(b);
          emit({ op: "jmp", off: loopStart } as RawInstruction);
          (code[patchExit] as { off: number }).off = code.length;
          const bt = breakTargets.pop()!;
          for (const p of bt.patches) (code[p] as { off: number }).off = code.length;
          continueTargets.pop();
          break;
        }
        case "для_каждого": {
          const depth = emitForCounter++;
          const srcSlot = locals.get(`__forEach_src_${depth}`)!;
          const lenSlot = locals.get(`__forEach_len_${depth}`)!;
          const idxSlot = locals.get(`__forEach_i_${depth}`)!;
          const itemSlot = locals.get(s.item)!;
          const indexSlot = s.index ? locals.get(s.index) : undefined;
          emitExpr(s.source, locals);
          emit({ op: "invoke", name: "система.итератор.из" } as RawInstruction);
          emit({ op: "local.set", i: srcSlot } as RawInstruction);
          emit({ op: "local.get", i: srcSlot } as RawInstruction);
          emit({ op: "invoke", name: "система.массив.длина" } as RawInstruction);
          emit({ op: "local.set", i: lenSlot } as RawInstruction);
          const k0 = constIndex(0);
          emit({ op: "const", type: "i32", k: k0 } as RawInstruction);
          emit({ op: "local.set", i: idxSlot } as RawInstruction);
          breakTargets.push({ patches: [] });
          const loopStart = code.length;
          const continueStart = loopStart + 0; // адрес для продолжить = начало проверки idx < len
          emit({ op: "local.get", i: idxSlot } as RawInstruction);
          emit({ op: "local.get", i: lenSlot } as RawInstruction);
          emit({ op: "lt" } as RawInstruction);
          const patchExit = code.length;
          emit({ op: "jmp_if_not", off: 0 } as RawInstruction);
          emit({ op: "local.get", i: srcSlot } as RawInstruction);
          emit({ op: "local.get", i: idxSlot } as RawInstruction);
          emit({ op: "invoke", name: "система.массив.получить" } as RawInstruction);
          emit({ op: "local.set", i: itemSlot } as RawInstruction);
          if (indexSlot !== undefined) {
            emit({ op: "local.get", i: idxSlot } as RawInstruction);
            emit({ op: "local.set", i: indexSlot } as RawInstruction);
          }
          const foreachContinue = { loopStart: continueStart, foreachPatches: [] as number[] };
          continueTargets.push(foreachContinue);
          for (const b of s.body) emitStmt(b);
          const incStart = code.length;
          for (const p of foreachContinue.foreachPatches) (code[p] as { off: number }).off = incStart;
          emit({ op: "local.get", i: idxSlot } as RawInstruction);
          const k1 = constIndex(1);
          emit({ op: "const", type: "i32", k: k1 } as RawInstruction);
          emit({ op: "add" } as RawInstruction);
          emit({ op: "local.set", i: idxSlot } as RawInstruction);
          emit({ op: "jmp", off: loopStart } as RawInstruction);
          (code[patchExit] as { off: number }).off = code.length;
          const btForEach = breakTargets.pop()!;
          for (const p of btForEach.patches) (code[p] as { off: number }).off = code.length;
          continueTargets.pop();
          break;
        }
        case "цикл": {
          breakTargets.push({ patches: [] });
          const loopStart = code.length;
          continueTargets.push({ loopStart });
          for (const b of s.body) emitStmt(b);
          emit({ op: "jmp", off: loopStart } as RawInstruction);
          const btCikl = breakTargets.pop()!;
          for (const p of btCikl.patches) (code[p] as { off: number }).off = code.length;
          continueTargets.pop();
          break;
        }
        case "прервать": {
          const target = breakTargets[breakTargets.length - 1];
          if (!target) {
            // Семантика: break_outside_loop — сюда не должны попадать при исправном AST;
            // жёсткая ошибка вместо const.null, чтобы bytecode не расходился с диагностикой.
            throw new Error("оператор 'прервать' допустим только внутри цикла");
          }
          target.patches.push(code.length);
          emit({ op: "jmp", off: 0 } as RawInstruction);
          break;
        }
        case "продолжить": {
          const ct = continueTargets[continueTargets.length - 1];
          if (!ct) {
            throw new Error("оператор 'продолжить' допустим только внутри цикла");
          }
          if (ct.foreachPatches) {
            ct.foreachPatches.push(code.length);
            emit({ op: "jmp", off: 0 } as RawInstruction);
          } else {
            emit({ op: "jmp", off: ct.loopStart } as RawInstruction);
          }
          break;
        }
        case "вернуть":
          if (s.value) emitExpr(s.value, locals);
          else emit({ op: "const.null" } as RawInstruction);
          emit({ op: "ret" } as RawInstruction);
          break;
        case "когда":
          throw new Error("когда должен быть развёрнут в если до codegen");
        default:
          assertNever(s, "Stmt.emitStmt");
      }
    };

    for (const s of proc.body) emitStmt(s);
    // Падение с конца без «вернуть»: исходник всё равно даёт значение (пусто),
    // иначе вызов как инструкция снимает pop с пустого стека.
    emit({ op: "const.null" } as RawInstruction);
    emit({ op: "ret" } as RawInstruction);

    procedures.push({
      name: proc.name,
      codeOffset,
      argc: proc.params.length,
      localsCount,
      pure: proc.pure,
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

function cloneExprWithResolver(expr: Expr, resolveCall: (name: string) => string): Expr {
  switch (expr.kind) {
    case "число":
    case "строка":
    case "булево":
    case "пусто":
    case "переменная":
      return { ...expr };
    case "бинарное":
      return {
        kind: "бинарное",
        op: expr.op,
        left: cloneExprWithResolver(expr.left, resolveCall),
        right: cloneExprWithResolver(expr.right, resolveCall),
      };
    case "унарное":
      return {
        kind: "унарное",
        op: expr.op,
        arg: cloneExprWithResolver(expr.arg, resolveCall),
      };
    case "вызов":
      return {
        kind: "вызов",
        name: resolveCall(expr.name),
        args: expr.args.map((a) => cloneExprWithResolver(a, resolveCall)),
      };
    case "массив":
      return {
        kind: "массив",
        elements: expr.elements.map((e) => cloneExprWithResolver(e, resolveCall)),
      };
    case "кортеж":
      return {
        kind: "кортеж",
        элементы: expr.элементы.map((e) => cloneExprWithResolver(e, resolveCall)),
      };
    case "объект":
      return {
        kind: "объект",
        entries: expr.entries.map((entry) => ({
          key: entry.key,
          value: cloneExprWithResolver(entry.value, resolveCall),
        })),
      };
    case "поле":
      return {
        kind: "поле",
        object: cloneExprWithResolver(expr.object, resolveCall),
        field: expr.field,
      };
    case "вариант":
      return { kind: "вариант", typeName: expr.typeName, variant: expr.variant };
    case "успех":
      return { kind: "успех", значение: cloneExprWithResolver(expr.значение, resolveCall) };
    case "неудача":
      return { kind: "неудача", значение: cloneExprWithResolver(expr.значение, resolveCall) };
    default:
      return assertNever(expr, "cloneExprWithResolver");
  }
}

function cloneStmtWithResolver(stmt: Stmt, resolveCall: (name: string) => string): Stmt {
  switch (stmt.kind) {
    case "пусть":
      return {
        kind: "пусть",
        name: stmt.name,
        init: cloneExprWithResolver(stmt.init, resolveCall),
        typeAnnotation: stmt.typeAnnotation ? { ...stmt.typeAnnotation } : undefined,
      };
    case "распаковать":
      return {
        kind: "распаковать",
        имена: [...stmt.имена],
        значение: cloneExprWithResolver(stmt.значение, resolveCall),
      };
    case "присвоить":
      return {
        kind: "присвоить",
        name: stmt.name,
        value: cloneExprWithResolver(stmt.value, resolveCall),
      };
    case "поле_присвоить":
      return {
        kind: "поле_присвоить",
        object: cloneExprWithResolver(stmt.object, resolveCall),
        field: stmt.field,
        value: cloneExprWithResolver(stmt.value, resolveCall),
      };
    case "выражение":
      return { kind: "выражение", expr: cloneExprWithResolver(stmt.expr, resolveCall) };
    case "если":
      return {
        kind: "если",
        condition: cloneExprWithResolver(stmt.condition, resolveCall),
        body: stmt.body.map((s) => cloneStmtWithResolver(s, resolveCall)),
        elseIfClauses: stmt.elseIfClauses?.map((cl) => ({
          condition: cloneExprWithResolver(cl.condition, resolveCall),
          body: cl.body.map((s) => cloneStmtWithResolver(s, resolveCall)),
        })),
        elseBody: stmt.elseBody?.map((s) => cloneStmtWithResolver(s, resolveCall)),
      };
    case "когда":
      return {
        kind: "когда",
        scrutinee: cloneExprWithResolver(stmt.scrutinee, resolveCall),
        arms: stmt.arms.map((arm) => ({
          variant: cloneExprWithResolver(arm.variant, resolveCall),
          body: arm.body.map((s) => cloneStmtWithResolver(s, resolveCall)),
        })),
        elseBody: stmt.elseBody?.map((s) => cloneStmtWithResolver(s, resolveCall)),
      };
    case "попробовать":
      return {
        kind: "попробовать",
        body: stmt.body.map((s) => cloneStmtWithResolver(s, resolveCall)),
        catchVar: stmt.catchVar,
        catchBody: stmt.catchBody.map((s) => cloneStmtWithResolver(s, resolveCall)),
      };
    case "выбросить":
      return { kind: "выбросить", value: cloneExprWithResolver(stmt.value, resolveCall) };
    case "пока":
      return {
        kind: "пока",
        condition: cloneExprWithResolver(stmt.condition, resolveCall),
        body: stmt.body.map((s) => cloneStmtWithResolver(s, resolveCall)),
      };
    case "для_каждого": {
      const source = cloneExprWithResolver(stmt.source, resolveCall);
      return {
        kind: "для_каждого",
        item: stmt.item,
        index: stmt.index,
        source,
        body: stmt.body.map((s) => cloneStmtWithResolver(s, resolveCall)),
        variable: stmt.variable,
        collection: source,
      };
    }
    case "цикл":
      return { kind: "цикл", body: stmt.body.map((s) => cloneStmtWithResolver(s, resolveCall)) };
    case "прервать":
      return { kind: "прервать" };
    case "продолжить":
      return { kind: "продолжить" };
    case "вернуть":
      return {
        kind: "вернуть",
        value: stmt.value ? cloneExprWithResolver(stmt.value, resolveCall) : undefined,
      };
    default:
      return assertNever(stmt, "cloneStmtWithResolver");
  }
}

function prefixProcedure(moduleName: string, procName: string): string {
  return `${moduleName}__${procName}`;
}

export function compileProgram(program: Program): OsVbcModule[] {
  const modulesByName = new Map<string, Module>();
  for (const m of program.modules) {
    if (!modulesByName.has(m.name)) modulesByName.set(m.name, m);
  }

  return program.modules.map((mod) => {
    const ownProcNames = new Set(mod.procedures.map((p) => p.name));
    const importedModules = mod.imports
      .map((imp) => modulesByName.get(imp.module))
      .filter((m): m is Module => !!m);
    const importedProcNames = new Set<string>();
    for (const imported of importedModules) {
      for (const p of imported.procedures) importedProcNames.add(p.name);
    }

    const compileProcedures: Procedure[] = [];
    const seenPrefixed = new Set<string>();

    const appendProcedure = (sourceModule: Module, proc: Procedure): void => {
      const prefixedName = prefixProcedure(sourceModule.name, proc.name);
      if (seenPrefixed.has(prefixedName)) return;
      seenPrefixed.add(prefixedName);

      const resolveCall = (name: string): string => {
        if (name.startsWith("система.")) return name;
        if (name.includes(".")) {
          const [ns, p] = name.split(".", 2);
          if (modulesByName.has(ns)) return prefixProcedure(ns, p ?? "");
          return name;
        }
        if (sourceModule.name === mod.name) {
          if (ownProcNames.has(name)) return prefixProcedure(mod.name, name);
          if (importedProcNames.has(name)) {
            for (const imported of importedModules) {
              if (imported.procedures.some((ip) => ip.name === name)) {
                return prefixProcedure(imported.name, name);
              }
            }
          }
          return name;
        }
        if (sourceModule.procedures.some((sp) => sp.name === name)) {
          return prefixProcedure(sourceModule.name, name);
        }
        return name;
      };

      compileProcedures.push({
        name: prefixedName,
        params: [...proc.params],
        paramTypes: proc.paramTypes ? [...proc.paramTypes] : undefined,
        returnType: proc.returnType,
        pure: proc.pure,
        body: proc.body.map((s) => cloneStmtWithResolver(s, resolveCall)),
        exported: proc.exported,
      });
    };

    for (const proc of mod.procedures) appendProcedure(mod, proc);
    for (const imported of importedModules) {
      for (const proc of imported.procedures) appendProcedure(imported, proc);
    }

    const compileModuleAst: Module = {
      name: mod.name,
      imports: [],
      typeDeclarations: [...mod.typeDeclarations],
      procedures: compileProcedures,
    };
    return compile(compileModuleAst);
  });
}
