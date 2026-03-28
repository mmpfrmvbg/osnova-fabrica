import type { Expr, Program, Module, Stmt } from "./ast";
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
    | "arg_count_mismatch"
    | "redeclare_var"
    | "keyword_param"
    | "keyword_as_identifier"
    | "invented_syntax"
    | "sentinel_pattern"
    | "unknown_module"
    | "export_collision"
    | "break_outside_loop"
    | "continue_outside_loop";
}

export interface SemanticResult {
  errors: SemanticError[];
}

const COMPARE_OPS = new Set(["==", "!=", "<", "<=", ">", ">="]);

function isCompareExpr(expr: Expr): boolean {
  return expr.kind === "бинарное" && COMPARE_OPS.has(expr.op);
}

interface ModuleSemanticContext {
  knownProcedures?: Set<string>;
  procedureArity?: Map<string, number>;
  namespaceProcedures?: Map<string, Map<string, number>>;
}

function checkModuleSemantics(ast: Module, context: ModuleSemanticContext = {}): SemanticError[] {
  const errors: SemanticError[] = [];
  const knownProcedures = context.knownProcedures ?? new Set(ast.procedures.map((p) => p.name));
  const procedureArity: Map<string, number> =
    context.procedureArity ??
    new Map(ast.procedures.map((p) => [p.name, p.params.length]));
  const namespaceProcedures = context.namespaceProcedures
    ?? new Map<string, Map<string, number>>();
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

  function isSentinelInit(expr: Expr): boolean {
    return expr.kind === "пусто";
  }

  function checkSentinelInStmts(stmts: Stmt[], insideTry: boolean): void {
    for (const stmt of stmts) {
      if (stmt.kind === "пусть" && isSentinelInit(stmt.init) && !insideTry) {
        errors.push({
          kind: "sentinel_pattern",
          message: `Переменная '${stmt.name}' инициализируется значением пусто — это sentinel-паттерн. Используйте попробовать/иначе_попытка вместо проверки == пусто`,
        });
      }
      switch (stmt.kind) {
        case "если":
          checkSentinelInStmts(stmt.body, insideTry);
          if (stmt.elseIfClauses) {
            for (const c of stmt.elseIfClauses) checkSentinelInStmts(c.body, insideTry);
          }
          if (stmt.elseBody) checkSentinelInStmts(stmt.elseBody, insideTry);
          break;
        case "пока":
          checkSentinelInStmts(stmt.body, insideTry);
          break;
        case "цикл":
          checkSentinelInStmts(stmt.body, insideTry);
          break;
        case "для_каждого":
          checkSentinelInStmts(stmt.body, insideTry);
          break;
        case "попробовать":
          checkSentinelInStmts(stmt.body, true);
          checkSentinelInStmts(stmt.catchBody, insideTry);
          break;
      }
    }
  }

  for (const proc of ast.procedures) {
    checkSentinelInStmts(proc.body, false);
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
        } else if (expr.name.includes(".")) {
          const [namespace, procName] = expr.name.split(".", 2);
          const exported = namespaceProcedures.get(namespace);
          if (!exported) {
            errors.push({
              kind: "unknown_module",
              message: `модуль '${namespace}' не найден`,
            });
          } else if (!exported.has(procName ?? "")) {
            errors.push({
              kind: "unknown_procedure",
              message: `процедура '${procName}' не экспортирована модулем '${namespace}'`,
            });
          } else {
            const expectedArity = exported.get(procName ?? "");
            if (expectedArity !== undefined && expr.args.length !== expectedArity) {
              errors.push({
                kind: "arg_count_mismatch",
                message: `процедура '${namespace}.${procName}' ожидает ${expectedArity} аргументов, получено ${expr.args.length}`,
              });
            }
          }
        } else if (!knownProcedures.has(expr.name)) {
          errors.push({
            kind: "unknown_procedure",
            message: `процедура '${expr.name}' не объявлена в модуле`,
          });
        } else {
          // Процедура известна — проверяем число аргументов
          const expectedArity = procedureArity.get(expr.name);
          if (expectedArity !== undefined && expr.args.length !== expectedArity) {
            errors.push({
              kind: "arg_count_mismatch",
              message: `процедура '${expr.name}' ожидает ${expectedArity} аргументов, получено ${expr.args.length}`,
            });
          }
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

  function checkStmts(stmts: Stmt[], declared: Set<string>, inLoop = false): void {
    for (const stmt of stmts) {
      switch (stmt.kind) {
        case "пусть":
          checkExpr(stmt.init, declared);
          if (kwSet.has(stmt.name)) {
            errors.push({
              kind: "keyword_as_identifier",
              message: `«${stmt.name}» является ключевым словом — используйте другое имя переменной`,
            });
            break;
          }
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
          checkExpr(stmt.object, declared);
          checkExpr(stmt.value, declared);
          break;
        case "если":
          checkExpr(stmt.condition, declared);
          checkStmts(stmt.body, new Set(declared), inLoop);
          if (stmt.elseIfClauses) {
            for (const clause of stmt.elseIfClauses) {
              checkExpr(clause.condition, declared);
              checkStmts(clause.body, new Set(declared), inLoop);
            }
          }
          if (stmt.elseBody) checkStmts(stmt.elseBody, new Set(declared), inLoop);
          break;
        case "пока":
          checkExpr(stmt.condition, declared);
          checkStmts(stmt.body, new Set(declared), true);
          break;
        case "цикл":
          checkStmts(stmt.body, new Set(declared), true);
          break;
        case "для_каждого": {
          const col = stmt.source ?? stmt.collection;
          if (col) checkExpr(col, declared);
          const loopScope = new Set(declared);
          const v = stmt.item ?? stmt.variable;
          loopScope.add(v);
          checkStmts(stmt.body, loopScope, true);
          break;
        }
        case "попробовать": {
          checkStmts(stmt.body, new Set(declared), inLoop);

          const catchScope = new Set(declared);
          catchScope.add(stmt.catchVar);
          checkStmts(stmt.catchBody, catchScope, inLoop);
          break;
        }
        case "прервать":
          if (!inLoop) {
            errors.push({
              kind: "break_outside_loop",
              message: "оператор 'прервать' допустим только внутри цикла",
            });
          }
          break;
        case "продолжить":
          if (!inLoop) {
            errors.push({
              kind: "continue_outside_loop",
              message: "оператор 'продолжить' допустим только внутри цикла",
            });
          }
          break;
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

export function checkSemantics(ast: Module): SemanticError[] {
  return checkModuleSemantics(ast);
}

interface ModuleExports {
  procedures: Map<string, number>;
  types: Set<string>;
}

export function analyzeProgram(program: Program): SemanticResult {
  const errors: SemanticError[] = [];
  const exportsByModuleName = new Map<string, ModuleExports[]>();

  for (const mod of program.modules) {
    const moduleExports: ModuleExports = {
      procedures: new Map(
        mod.procedures
          .filter((p) => p.exported)
          .map((p) => [p.name, p.params.length]),
      ),
      // На текущем этапе типы считаем доступными в пределах экспортирующего namespace.
      types: new Set(mod.typeDeclarations.map((t) => t.name)),
    };
    const list = exportsByModuleName.get(mod.name) ?? [];
    if (list.length > 0) {
      for (const prev of list) {
        moduleExports.procedures.forEach((_, proc) => {
          if (prev.procedures.has(proc)) {
            errors.push({
              kind: "export_collision",
              message: `коллизия экспортов: модуль '${mod.name}' экспортирует процедуру '${proc}' более одного раза`,
            });
          }
        });
      }
    }
    list.push(moduleExports);
    exportsByModuleName.set(mod.name, list);
  }

  for (const mod of program.modules) {
    const namespaceProcedures = new Map<string, Map<string, number>>();
    for (const imp of mod.imports) {
      const providers = exportsByModuleName.get(imp.module);
      if (!providers || providers.length === 0) {
        errors.push({
          kind: "unknown_module",
          message: `модуль '${imp.module}' не найден`,
        });
        continue;
      }
      const merged = new Map<string, number>();
      for (const provider of providers) {
        provider.procedures.forEach((arity, proc) => {
          if (merged.has(proc)) {
            errors.push({
              kind: "export_collision",
              message: `коллизия экспортов: namespace '${imp.module}' содержит дубликат процедуры '${proc}'`,
            });
          }
          merged.set(proc, arity);
        });
      }
      namespaceProcedures.set(imp.module, merged);
    }
    errors.push(
      ...checkModuleSemantics(mod, {
        knownProcedures: new Set(mod.procedures.map((p) => p.name)),
        procedureArity: new Map(mod.procedures.map((p) => [p.name, p.params.length])),
        namespaceProcedures,
      }),
    );
  }

  return { errors };
}
