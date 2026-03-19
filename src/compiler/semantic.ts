import type { Expr, Module, Stmt } from "./ast";
import { LANGUAGE_REGISTRY } from "./language-registry";

export interface SemanticError {
  message: string;
  line?: number;
  kind:
    | "undeclared_var"
    | "syscall_argc"
    | "chained_compare"
    | "unknown_syscall"
    | "unknown_procedure"
    | "redeclare_var"
    | "keyword_param";
}

const COMPARE_OPS = new Set(["==", "!=", "<", "<=", ">", ">="]);

function isCompareExpr(expr: Expr): boolean {
  return expr.kind === "бинарное" && COMPARE_OPS.has(expr.op);
}

export function checkSemantics(ast: Module): SemanticError[] {
  const errors: SemanticError[] = [];
  const knownProcedures = new Set(ast.procedures.map((p) => p.name));
  const kwSet = new Set(LANGUAGE_REGISTRY.keywords.map((k) => k.lexeme));

  function checkExpr(expr: Expr, declared: Set<string>): void {
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
        } else if (!knownProcedures.has(expr.name)) {
          errors.push({
            kind: "unknown_procedure",
            message: `процедура '${expr.name}' не объявлена в модуле`,
          });
        }
        for (const arg of expr.args) checkExpr(arg, declared);
        return;
      case "бинарное":
        checkExpr(expr.left, declared);
        checkExpr(expr.right, declared);
        if (COMPARE_OPS.has(expr.op) && (isCompareExpr(expr.left) || isCompareExpr(expr.right))) {
          errors.push({
            kind: "chained_compare",
            message: "цепочечные сравнения не поддерживаются, используй 'и'",
          });
        }
        return;
      case "поле":
        checkExpr(expr.object, declared);
        return;
      case "унарное":
        checkExpr(expr.arg, declared);
        return;
      case "массив":
        for (const el of expr.elements) checkExpr(el, declared);
        return;
      case "объект":
        for (const entry of expr.entries) checkExpr(entry.value, declared);
        return;
      case "число":
      case "строка":
      case "булево":
      case "пусто":
        return;
    }
  }

  function checkStmts(stmts: Stmt[], declared: Set<string>): void {
    for (const stmt of stmts) {
      switch (stmt.kind) {
        case "пусть":
          checkExpr(stmt.init, declared);
          if (declared.has(stmt.name)) {
            errors.push({
              kind: "redeclare_var",
              message: `повторное объявление '${stmt.name}' через пусть — используй просто '${stmt.name} = ...'`,
            });
          }
          declared.add(stmt.name);
          break;
        case "присвоить":
          if (!declared.has(stmt.name)) {
            errors.push({
              kind: "undeclared_var",
              message: `переменная '${stmt.name}' используется без объявления через пусть`,
            });
          }
          checkExpr(stmt.value, declared);
          break;
        case "поле_присвоить":
          if (!declared.has(stmt.object)) {
            errors.push({
              kind: "undeclared_var",
              message: `переменная '${stmt.object}' используется без объявления через пусть`,
            });
          }
          checkExpr(stmt.value, declared);
          break;
        case "если":
          checkExpr(stmt.condition, declared);
          checkStmts(stmt.body, new Set(declared));
          if (stmt.elseIfClauses) {
            for (const clause of stmt.elseIfClauses) {
              checkExpr(clause.condition, declared);
              checkStmts(clause.body, new Set(declared));
            }
          }
          if (stmt.elseBody) checkStmts(stmt.elseBody, new Set(declared));
          break;
        case "пока":
          checkExpr(stmt.condition, declared);
          checkStmts(stmt.body, new Set(declared));
          break;
        case "цикл":
          checkStmts(stmt.body, new Set(declared));
          break;
        case "для_каждого": {
          checkExpr(stmt.collection, declared);
          const loopScope = new Set(declared);
          loopScope.add(stmt.variable);
          checkStmts(stmt.body, loopScope);
          break;
        }
        case "выражение":
          checkExpr(stmt.expr, declared);
          break;
        case "вернуть":
          if (stmt.value) checkExpr(stmt.value, declared);
          break;
      }
    }
  }

  for (const proc of ast.procedures) {
    for (const param of proc.params) {
      if (kwSet.has(param)) {
        errors.push({
          kind: "keyword_param",
          message: `параметр '${param}' является ключевым словом — используй другое имя`,
        });
      }
    }
    const declared = new Set<string>(proc.params);
    checkStmts(proc.body, declared);
  }
  return errors;
}
