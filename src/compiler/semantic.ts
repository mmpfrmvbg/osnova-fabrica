import type { Expr, Program, Module, Stmt } from "./ast";
import type { SemanticKind } from "./semanticKinds";
import { unknownSyscallMessage } from "../runtime/vm/invokeRegistry";
import { LANGUAGE_REGISTRY } from "./language-registry";

export interface SemanticError {
  message: string;
  line?: number;
  /**
   * Файл, к которому относится ошибка. Ставится, потому что импорты
   * разворачиваются: без него ошибка внутри импортируемого модуля называлась бы
   * сборкой главного (`Procedure.origin`, `expandModuleImports`).
   */
  file?: string;
  /**
   * Вид ошибки. Объединение имён — из единого каталога
   * (`src/compiler/diagnosticCatalogue.ts`), а не свой список здесь: прежде
   * inline-union из 15 видов жил отдельно от списков `semanticKinds.ts` (9), и
   * шесть видов не видела ни одна проверка «блокирует ли это сборку».
   */
  kind: SemanticKind;
}

export interface SemanticResult {
  errors: SemanticError[];
}

/** Хост-вызов вне `система.*` (например `игра.очистить`). Не пишется в language-registry. */
export interface HostSyscallSpec {
  name: string;
  argc: number;
}

export interface SemanticOptions {
  extraSyscalls?: HostSyscallSpec[];
  /**
   * Имя входного файла — файл по умолчанию для диагностики.
   *
   * Ошибка внутри процедуры называет СВОЙ файл (`Procedure.origin`), а этот —
   * для ошибок уровня модуля, где процедуры ещё не назвали себя.
   */
  filename?: string;
}

const COMPARE_OPS = new Set(["==", "!=", "<", "<=", ">", ">="]);

function isCompareExpr(expr: Expr): boolean {
  return expr.kind === "бинарное" && COMPARE_OPS.has(expr.op);
}

interface ModuleSemanticContext {
  knownProcedures?: Set<string>;
  procedureArity?: Map<string, number>;
  namespaceProcedures?: Map<string, Map<string, number>>;
  extraSyscallByName?: Map<string, number>;
  hostNamespaces?: Set<string>;
  /** Файл по умолчанию для диагностики — см. {@link SemanticOptions.filename}. */
  filename?: string;
}

function checkModuleSemantics(ast: Module, context: ModuleSemanticContext = {}): SemanticError[] {
  const errors: SemanticError[] = [];
  /**
   * Файл, к которому относится проверяемое сейчас место.
   *
   * Переставляется на каждой процедуре из её `origin`: импорты разворачиваются, и
   * без этого ошибка внутри встроенной процедуры называла бы сборкой главного
   * модуля. Проверено замером: `модуль 'ЗадачиПриоритеты' не найден`, возникшая в
   * `tasks_core.osnova`, приписывалась `main.osnova`.
   */
  let currentFile: string | undefined = context.filename;
  const knownProcedures = context.knownProcedures ?? new Set(ast.procedures.map((p) => p.name));
  const procedureArity: Map<string, number> =
    context.procedureArity ??
    new Map(ast.procedures.map((p) => [p.name, p.params.length]));
  const namespaceProcedures = context.namespaceProcedures
    ?? new Map<string, Map<string, number>>();
  const extraSyscallByName = context.extraSyscallByName ?? new Map<string, number>();
  const hostNamespaces = context.hostNamespaces ?? new Set<string>();
  // Закрывающие блоки лексемы (`конец`, `конец_если`, …) — контекстные, а не
  // зарезервированные: вне позиции закрытия это обычные имена. Поэтому в набор
  // «ключевых слов, которыми нельзя называть» они не входят (БЛОК 1 v2).
  const kwSet = new Set(
    LANGUAGE_REGISTRY.keywords
      .filter((k) => k.kind !== "block")
      .map((k) => k.lexeme),
  );

  // ─── RFC-003: invented syntax check ───
  function checkInventedSyntaxInExpr(expr: Expr): void {
    switch (expr.kind) {
      case "вызов": {
        if (expr.name === "структура") {
          errors.push({
            kind: "invented_syntax",
            file: currentFile,
            message:
              "Конструкция 'структура(...)' не существует в языке Основа. Используйте объектный литерал: { поле: значение }",
          });
        }
        if (expr.name.startsWith("система.типы.")) {
          errors.push({
            kind: "invented_syntax",
            file: currentFile,
            message: `Конструкция '${expr.name}' не существует в языке Основа. Именованный тип объявляется: тип Имя = { поле: Тип } (перечень: тип Имя = вариант | вариант)`,
          });
        }
        if (expr.name === "система.хранилище.установить_поле") {
          errors.push({
            kind: "invented_syntax",
            file: currentFile,
            message:
              "Конструкция 'система.хранилище.установить_поле' не существует. Поле объекта устанавливается присваиванием: объект.поле = значение",
          });
        }
        // только .новый — система.объект.получить валиден в реестре
        if (expr.name === "система.объект.новый") {
          errors.push({
            kind: "invented_syntax",
            file: currentFile,
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
        case "когда":
          checkInventedSyntaxInExpr(stmt.scrutinee);
          for (const arm of stmt.arms) {
            checkInventedSyntaxInExpr(arm.variant);
            checkInventedSyntaxInStmts(arm.body);
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

    currentFile = proc.origin ?? context.filename;
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
          file: currentFile,
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
        case "когда":
          checkSentinelInStmts(
            stmt.arms.flatMap((a) => a.body).concat(stmt.elseBody ?? []),
            insideTry,
          );
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

    currentFile = proc.origin ?? context.filename;
    checkSentinelInStmts(proc.body, false);
  }

  function checkExpr(expr: Expr, declared: Set<string>): void {
    switch (expr.kind) {
      case "переменная":
        if (!declared.has(expr.name)) {
          errors.push({
            kind: "undeclared_var",
            file: currentFile,
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
              file: currentFile,
              message: unknownSyscallMessage(expr.name),
            });
          } else if (expr.args.length !== spec.argc) {
            errors.push({
              kind: "syscall_argc",
              file: currentFile,
              message: `'${expr.name}' ожидает ${spec.argc} аргументов, передано ${expr.args.length}`,
            });
          }
        } else if (expr.name.includes(".")) {
          const hostArgc = extraSyscallByName.get(expr.name);
          if (hostArgc !== undefined) {
            if (expr.args.length !== hostArgc) {
              errors.push({
                kind: "syscall_argc",
                file: currentFile,
                message: `'${expr.name}' ожидает ${hostArgc} аргументов, передано ${expr.args.length}`,
              });
            }
          } else {
            const [namespace, procName] = expr.name.split(".", 2);
            if (hostNamespaces.has(namespace ?? "")) {
              errors.push({
                kind: "unknown_syscall",
                file: currentFile,
                message: `хост-вызов '${expr.name}' не существует`,
              });
            } else {
              const exported = namespaceProcedures.get(namespace);
              if (!exported) {
                errors.push({
                  kind: "unknown_module",
                  file: currentFile,
                  message: `модуль '${namespace}' не найден`,
                });
              } else if (!exported.has(procName ?? "")) {
                errors.push({
                  kind: "unknown_procedure",
                  file: currentFile,
                  message: `процедура '${procName}' не экспортирована модулем '${namespace}'`,
                });
              } else {
                const expectedArity = exported.get(procName ?? "");
                if (expectedArity !== undefined && expr.args.length !== expectedArity) {
                  errors.push({
                    kind: "arg_count_mismatch",
                    file: currentFile,
                    message: `процедура '${namespace}.${procName}' ожидает ${expectedArity} аргументов, получено ${expr.args.length}`,
                  });
                }
              }
            }
          }
        } else if (!knownProcedures.has(expr.name)) {
          errors.push({
            kind: "unknown_procedure",
            file: currentFile,
            message: `процедура '${expr.name}' не объявлена в модуле`,
          });
        } else {
          // Процедура известна — проверяем число аргументов
          const expectedArity = procedureArity.get(expr.name);
          if (expectedArity !== undefined && expr.args.length !== expectedArity) {
            errors.push({
              kind: "arg_count_mismatch",
              file: currentFile,
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
            file: currentFile,
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
              file: currentFile,
              message: `«${stmt.name}» является ключевым словом — используйте другое имя переменной`,
            });
            break;
          }
          if (declared.has(stmt.name)) {
            errors.push({
              kind: "redeclare_var",
              file: currentFile,
              message: `повторное объявление '${stmt.name}' через пусть — используй просто '${stmt.name} = ...'`,
            });
          }
          declared.add(stmt.name);
          break;
        case "присвоить":
          if (!declared.has(stmt.name)) {
            errors.push({
              kind: "undeclared_var",
              file: currentFile,
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
        case "когда":
          checkExpr(stmt.scrutinee, declared);
          for (const arm of stmt.arms) {
            checkExpr(arm.variant, declared);
            checkStmts(arm.body, new Set(declared), inLoop);
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
              file: currentFile,
              message: "оператор 'прервать' допустим только внутри цикла",
            });
          }
          break;
        case "продолжить":
          if (!inLoop) {
            errors.push({
              kind: "continue_outside_loop",
              file: currentFile,
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

    currentFile = proc.origin ?? context.filename;
    for (const param of proc.params) {
      if (kwSet.has(param)) {
        errors.push({
          kind: "keyword_param",
          file: currentFile,
          message: `параметр '${param}' является ключевым словом — используй другое имя`,
        });
      }
    }
    const declared = new Set<string>(proc.params);
    checkStmts(proc.body, declared);
  }
  return errors;
}

export function checkSemantics(ast: Module, options: SemanticOptions = {}): SemanticError[] {
  return checkModuleSemantics(ast, { filename: options.filename });
}

interface ModuleExports {
  procedures: Map<string, number>;
  types: Set<string>;
}

export function analyzeProgram(program: Program, options: SemanticOptions = {}): SemanticResult {
  const errors: SemanticError[] = [];
  const extraSyscallByName = new Map<string, number>();
  const hostNamespaces = new Set<string>();
  for (const s of options.extraSyscalls ?? []) {
    extraSyscallByName.set(s.name, s.argc);
    const ns = s.name.split(".", 1)[0];
    if (ns) hostNamespaces.add(ns);
  }
  const exportsByModuleName = new Map<string, ModuleExports[]>();

  /** Файл уровня модуля: у самого `Module` поля нет, берём из его процедур. */
  let currentFile: string | undefined = options.filename;

  for (const mod of program.modules) {
    currentFile = mod.procedures[0]?.origin ?? options.filename;
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
              file: currentFile,
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
          file: currentFile,
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
              file: currentFile,
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
        extraSyscallByName,
        hostNamespaces,
        filename: currentFile,
      }),
    );
  }

  return { errors };
}
