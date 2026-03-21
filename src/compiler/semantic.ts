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
    | "keyword_param"
    | "invented_syntax";
}

const COMPARE_OPS = new Set(["==", "!=", "<", "<=", ">", ">="]);

function isCompareExpr(expr: Expr): boolean {
  return expr.kind === "бинарное" && COMPARE_OPS.has(expr.op);
}

export function checkSemantics(ast: Module): SemanticError[] {
  const errors: SemanticError[] = [];
  const knownProcedures = new Set(ast.procedures.map((p) => p.name));
  const kwSet = new Set(LANGUAGE_REGISTRY.keywords.map((k) => k.lexeme));

  // ─── RFC-003: invented syntax check ───
  function checkInventedSyntaxInExpr(expr: Expr): void {
    switch (expr.kind) {
      case "вызов": {
        if (expr.name === "структура") {
          errors.push({
            kind: "invented_syntax",
            message:
              "Конструкция 'структура(...)' не существует в языке Основа. Используйте объектный литерал: { поле: значение }",
          });
        }
        if (expr.name.startsWith("система.типы.")) {
          errors.push({
            kind: "invented_syntax",
            message: `Конструкция '${expr.name}' не существует в языке Основа. Используйте объектный литерал: { поле: значение }`,
          });
        }
        if (expr.name === "система.хранилище.установить_поле") {
          errors.push({
            kind: "invented_syntax",
            message:
              "Конструкция 'система.хранилище.установить_поле' не существует. Используйте система.хранилище.записать(ключ, значение)",
          });
        }
        // только .новый — система.объект.получить валиден в реестре
        if (expr.name === "система.объект.новый") {
          errors.push({
            kind: "invented_syntax",
            message: `Конструкция '${expr.name}' не существует в языке Основа. Используйте объектный литерал: { поле: значение }`,
          });
        }
        for (const arg of expr.args) checkInventedSyntaxInExpr(arg);
        break;
      }
      case "бинарное":
        checkInventedSyntaxInExpr(expr.left);
        checkInventedSyntaxInExpr(expr.right);
        break;
      case "поле":
        checkInventedSyntaxInExpr(expr.object);
        break;
      case "унарное":
        checkInventedSyntaxInExpr(expr.arg);
        break;
      case "массив":
        for (const el of expr.elements) checkInventedSyntaxInExpr(el);
        break;
      case "объект":
        for (const entry of expr.entries) checkInventedSyntaxInExpr(entry.value);
        break;
      default:
        break;
    }
  }

  function checkInventedSyntaxInStmts(stmts: Stmt[]): void {
    for (const stmt of stmts) {
      switch (stmt.kind) {
        case "пусть":
          if (stmt.name === "данные") {
            errors.push({
              kind: "invented_syntax",
              message: "Идентификатор 'данные' зарезервирован. Используйте пусть имя = значение",
            });
          }
          checkInventedSyntaxInExpr(stmt.init);
          break;
        case "присвоить":
          checkInventedSyntaxInExpr(stmt.value);
          break;
        case "поле_присвоить":
          checkInventedSyntaxInExpr(stmt.value);
          break;
        case "выражение":
          checkInventedSyntaxInExpr(stmt.expr);
          break;
        case "вернуть":
          if (stmt.value) checkInventedSyntaxInExpr(stmt.value);
          break;
        case "выбросить":
          checkInventedSyntaxInExpr(stmt.value);
          break;
        case "если":
          checkInventedSyntaxInExpr(stmt.condition);
          checkInventedSyntaxInStmts(stmt.body);
          if (stmt.elseIfClauses) {
            for (const c of stmt.elseIfClauses) {
              checkInventedSyntaxInExpr(c.condition);
              checkInventedSyntaxInStmts(c.body);
            }
          }
          if (stmt.elseBody) checkInventedSyntaxInStmts(stmt.elseBody);
          break;
        case "пока":
          checkInventedSyntaxInExpr(stmt.condition);
          checkInventedSyntaxInStmts(stmt.body);
          break;
        case "цикл":
          checkInventedSyntaxInStmts(stmt.body);
          break;
        case "для_каждого": {
          const col = stmt.source ?? stmt.collection;
          if (col) checkInventedSyntaxInExpr(col);
          checkInventedSyntaxInStmts(stmt.body);
          break;
        }
        case "попробовать":
          checkInventedSyntaxInStmts(stmt.body);
          checkInventedSyntaxInStmts(stmt.catchBody);
          break;
      }
    }
  }

  for (const proc of ast.procedures) {
    checkInventedSyntaxInStmts(proc.body);
  }

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
        if (expr.name === "структура") {
          for (const arg of expr.args) checkExpr(arg, declared);
          return;
        }
        if (expr.name.startsWith("система.типы.")) {
          for (const arg of expr.args) checkExpr(arg, declared);
          return;
        }
        if (expr.name === "система.хранилище.установить_поле") {
          for (const arg of expr.args) checkExpr(arg, declared);
          return;
        }
        if (expr.name === "система.объект.новый") {
          for (const arg of expr.args) checkExpr(arg, declared);
          return;
        }
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
          const col = stmt.source ?? stmt.collection;
          if (col) checkExpr(col, declared);
          const loopScope = new Set(declared);
          const v = stmt.item ?? stmt.variable;
          loopScope.add(v);
          checkStmts(stmt.body, loopScope);
          break;
        }
        case "попробовать": {
          checkStmts(stmt.body, new Set(declared));

          const catchScope = new Set(declared);
          catchScope.add(stmt.catchVar);
          checkStmts(stmt.catchBody, catchScope);
          break;
        }
        case "выражение":
          checkExpr(stmt.expr, declared);
          break;
        case "выбросить":
          checkExpr(stmt.value, declared);
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
