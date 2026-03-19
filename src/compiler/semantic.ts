import type { Expr, Module, Stmt } from "./ast";
import { LANGUAGE_REGISTRY } from "./language-registry";

export interface SemanticError {
  message: string;
  line?: number;
  kind: "undeclared_var" | "syscall_argc" | "chained_compare" | "unknown_syscall";
}

const COMPARE_OPS = new Set(["==", "!=", "<", "<=", ">", ">="]);

function isCompareExpr(expr: Expr): boolean {
  return expr.kind === "бинарное" && COMPARE_OPS.has(expr.op);
}

function checkExpr(expr: Expr, declared: Set<string>, errors: SemanticError[]): void {
  switch (expr.kind) {
    case "переменная":
      if (!declared.has(expr.name)) {
        errors.push({
          kind: "undeclared_var",
          message: `переменная '${expr.name}' используется без объявления через пусть`,
        });
      }
      return;
    case "вызов":
      if (expr.name.startsWith("система.")) {
        const spec = LANGUAGE_REGISTRY.syscalls.find((s) => s.name === expr.name);
        if (!spec) {
          errors.push({
            kind: "unknown_syscall",
            message: `системный вызов '${expr.name}' не существует`,
          });
        } else if (expr.args.length !== spec.argc) {
          errors.push({
            kind: "syscall_argc",
            message: `'${expr.name}' ожидает ${spec.argc} аргументов, передано ${expr.args.length}`,
          });
        }
      }
      for (const arg of expr.args) checkExpr(arg, declared, errors);
      return;
    case "бинарное":
      checkExpr(expr.left, declared, errors);
      checkExpr(expr.right, declared, errors);
      if (COMPARE_OPS.has(expr.op) && (isCompareExpr(expr.left) || isCompareExpr(expr.right))) {
        errors.push({
          kind: "chained_compare",
          message: "цепочечные сравнения не поддерживаются, используй 'и'",
        });
      }
      return;
    case "поле":
      checkExpr(expr.object, declared, errors);
      return;
    case "унарное":
      checkExpr(expr.arg, declared, errors);
      return;
    case "массив":
      for (const el of expr.elements) checkExpr(el, declared, errors);
      return;
    case "объект":
      for (const entry of expr.entries) checkExpr(entry.value, declared, errors);
      return;
    case "число":
    case "строка":
    case "булево":
    case "пусто":
      return;
  }
}

function checkStmts(stmts: Stmt[], declared: Set<string>, errors: SemanticError[]): void {
  for (const stmt of stmts) {
    switch (stmt.kind) {
      case "пусть":
        checkExpr(stmt.init, declared, errors);
        declared.add(stmt.name);
        break;
      case "присвоить":
        if (!declared.has(stmt.name)) {
          errors.push({
            kind: "undeclared_var",
            message: `переменная '${stmt.name}' используется без объявления через пусть`,
          });
        }
        checkExpr(stmt.value, declared, errors);
        break;
      case "поле_присвоить":
        if (!declared.has(stmt.object)) {
          errors.push({
            kind: "undeclared_var",
            message: `переменная '${stmt.object}' используется без объявления через пусть`,
          });
        }
        checkExpr(stmt.value, declared, errors);
        break;
      case "если":
        checkExpr(stmt.condition, declared, errors);
        checkStmts(stmt.body, new Set(declared), errors);
        if (stmt.elseIfClauses) {
          for (const clause of stmt.elseIfClauses) {
            checkExpr(clause.condition, declared, errors);
            checkStmts(clause.body, new Set(declared), errors);
          }
        }
        if (stmt.elseBody) checkStmts(stmt.elseBody, new Set(declared), errors);
        break;
      case "пока":
        checkExpr(stmt.condition, declared, errors);
        checkStmts(stmt.body, new Set(declared), errors);
        break;
      case "цикл":
        checkStmts(stmt.body, new Set(declared), errors);
        break;
      case "для_каждого": {
        checkExpr(stmt.collection, declared, errors);
        const loopScope = new Set(declared);
        loopScope.add(stmt.variable);
        checkStmts(stmt.body, loopScope, errors);
        break;
      }
      case "выражение":
        checkExpr(stmt.expr, declared, errors);
        break;
      case "вернуть":
        if (stmt.value) checkExpr(stmt.value, declared, errors);
        break;
    }
  }
}

export function checkSemantics(ast: Module): SemanticError[] {
  const errors: SemanticError[] = [];
  for (const proc of ast.procedures) {
    const declared = new Set<string>(proc.params);
    checkStmts(proc.body, declared, errors);
  }
  return errors;
}
