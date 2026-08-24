/**
 * Компилятор Основа MVP: .osnova → OsVbcModule (JSON .osvbc).
 * Пайплайн: tokenize → parse → compile → JSON.
 *
 * Поля CompileResult → BuildReport (orchestrator.compileToBuildReport):
 *   module → bytecode; compilerSuccess; lexer/parser/compiler errors; semanticErrors; durationMs.
 *   Опционально modules[] при multi-module Program.
 *
 * Байткод исполняется VM: канон имён опкодов — {@link import("../runtime/vm/bytecode").Op},
 * диспетчеризация шага — {@link import("../runtime/vm/interpreter").VM} / interpretInstruction.
 */

import { tokenize } from './lexer';
import { parse, type ParseError } from './parser';
import { compile, compileProgram } from './codegen';
import { isVliwPacket, type CodeElement, type OsVbcModule, type RawInstruction } from '../runtime/vm/bytecode';
import { OsVbcVM, type OsVbcVMOptions, type StackValue } from '../runtime/vm';
import { InterpreterError } from '../runtime/vm/interpreter';
import { analyzeProgram, type SemanticError, type HostSyscallSpec } from './semantic';
import { BLOCKING_SEMANTIC_KINDS } from './semanticKinds';
import type { Expr, Program, Module, Procedure, Stmt, TypeDeclaration, TypeRef } from './ast';
import * as fs from 'fs';
import * as path from 'path';
import type { BuildReport } from '../pipeline/types';

/**
 * Базовый интерфейс ошибки компиляции.
 * Используется для унификации ошибок всех фаз: lexer, parser, semantic, codegen.
 */
export interface CompileError {
  /** Сообщение об ошибке */
  message: string;
  /** Номер строки (опционально) */
  line?: number;
  /** Номер колонки (опционально) */
  column?: number;
  /** Тип/категория ошибки */
  kind?: string;
  /** Узел AST или контекст (опционально) */
  node?: string;
}

export interface CompileResult {
  /** Скомпилированный модуль — null если есть ошибки */
  module: OsVbcModule | null;
  /** Скомпилированные модули Program (multi-module path) */
  modules?: OsVbcModule[];
  /** true если компилятор отработал без ошибок */
  compilerSuccess: boolean;
  /** Ошибки лексера */
  lexerErrors: { message: string; line: number; column: number }[];
  /** Ошибки парсера */
  parserErrors: ParseError[];
  /** Ошибки компилятора (codegen-фаза) */
  compilerErrors: { message: string; node?: string }[];
  /** Ошибки семантического анализатора (предупреждения первого этапа) */
  semanticErrors: SemanticError[];
  /** Время компиляции в мс */
  durationMs: number;
  /** Логи компиляции для отладки и трассировки */
  logs?: CompileLog[];
}

/** Запись лога компиляции */
export interface CompileLog {
  /** Уровень лога */
  level: 'info' | 'warn' | 'error';
  /** Фаза компиляции */
  phase: 'lexer' | 'parser' | 'semantic' | 'codegen';
  /** Сообщение */
  message: string;
  /** Время события (мс от начала компиляции) */
  timestamp: number;
  /** Контекст ошибки (опционально) */
  error?: CompileError;
}

export interface CompileOptions {
  /** Базовая директория для разрешения импортов `использовать ... из "путь"`. */
  baseDir?: string;
  /**
   * Хост-вызовы вне `система.*` (например `игра.очистить`).
   * Проверяются как syscall (имя + argc). Не добавляются в language-registry.
   */
  extraSyscalls?: HostSyscallSpec[];
}

/** Опции полного цикла: компиляция + запуск через {@link OsVbcVM} (обёртка над Interpreter/VM). */
export interface ExecuteOptions extends CompileOptions {
  /** Индекс процедуры (по умолчанию 0). */
  procedureIndex?: number;
  /** Имя процедуры; если задано, имеет приоритет над procedureIndex. */
  procedureName?: string;
  /** Аргументы вызова процедуры. */
  args?: StackValue[];
  /** Опции {@link OsVbcVM}: invoke, maxSteps, globals, onExecutionLog и т.д. */
  vm?: OsVbcVMOptions;
}

/**
 * Обёртка над пайплайном tokenize → parse → semantic → codegen → VM.
 * `compile()` — тот же контракт, что `compileSource()`; фаза build в PlanAgent
 * (`compileOsnovaSource` в plan-agent.ts) и `execute()` используют этот метод.
 */
export class Compiler {
  compile(source: string, options: CompileOptions = {}): CompileResult {
    return compileSource(source, options);
  }

  /**
   * Компилирует исходник и выполняет одну процедуру через {@link OsVbcVM} (тот же байткод и опкоды, что у {@link import("../runtime/vm/interpreter").VM}).
   * При ошибках компиляции бросает Error с агрегированным сообщением.
   */
  async execute(source: string, options: ExecuteOptions = {}): Promise<StackValue | undefined> {
    const { procedureIndex = 0, procedureName, args = [], vm: vmOpts, baseDir } = options;
    const result = this.compile(source, { baseDir, extraSyscalls: options.extraSyscalls });
    const msg = formatCompileFailureMessage(result);
    if (!result.module || msg) {
      throw new Error(msg || 'compilation failed');
    }
    const osvm = new OsVbcVM(result.module, vmOpts ?? {});
    let procedure: string;
    if (procedureName !== undefined) {
      procedure = procedureName;
    } else {
      const def = result.module.procedures[procedureIndex];
      if (!def) {
        throw new InterpreterError(`Invalid procedure index: ${procedureIndex}`);
      }
      procedure = def.name;
    }
    return await osvm.execute({ procedure, args });
  }
}

/** Вспомогательная функция для добавления записи лога */
function addLog(
  logs: CompileLog[],
  level: CompileLog['level'],
  phase: CompileLog['phase'],
  message: string,
  startTime: number,
  error?: CompileError
): void {
  logs.push({
    level,
    phase,
    message,
    timestamp: Date.now() - startTime,
    error,
  });
}

/** Преобразует ошибку в интерфейс CompileError */
function toCompileError(
  error: Error | { message: string },
  line?: number,
  column?: number,
  kind?: string
): CompileError {
  return {
    message: error.message,
    line,
    column,
    kind,
  };
}

function resolveImportPath(importPath: string, baseDir: string, rootDir: string): string {
  if (path.isAbsolute(importPath)) {
    throw new Error(`Импорт только относительный: ${importPath}`);
  }
  const resolved = path.resolve(baseDir, importPath);
  const root = path.resolve(rootDir);
  const rel = path.relative(root, resolved);
  if (rel.startsWith("..") || path.isAbsolute(rel)) {
    throw new Error(`Импорт вне каталога: ${importPath}`);
  }
  return resolved;
}

function rewriteExprCalls(expr: Expr, rewriter: (calleeName: string) => string): void {
  switch (expr.kind) {
    case "вызов": {
      expr.name = rewriter(expr.name);
      for (const a of expr.args) rewriteExprCalls(a, rewriter);
      return;
    }
    case "бинарное":
      rewriteExprCalls(expr.left, rewriter);
      rewriteExprCalls(expr.right, rewriter);
      return;
    case "унарное":
      rewriteExprCalls(expr.arg, rewriter);
      return;
    case "поле":
      rewriteExprCalls(expr.object, rewriter);
      return;
    case "массив":
      for (const e of expr.elements) rewriteExprCalls(e, rewriter);
      return;
    case "объект":
      for (const { value } of expr.entries) rewriteExprCalls(value, rewriter);
      return;
    default:
      return;
  }
}

function rewriteStmtCalls(stmt: Stmt, rewriter: (calleeName: string) => string): void {
  switch (stmt.kind) {
    case "пусть":
      rewriteExprCalls(stmt.init, rewriter);
      return;
    case "присвоить":
      rewriteExprCalls(stmt.value, rewriter);
      return;
    case "поле_присвоить":
      rewriteExprCalls(stmt.value, rewriter);
      return;
    case "выражение":
      rewriteExprCalls(stmt.expr, rewriter);
      return;
    case "если":
      rewriteExprCalls(stmt.condition, rewriter);
      for (const s of stmt.body) rewriteStmtCalls(s, rewriter);
      if (stmt.elseIfClauses) {
        for (const c of stmt.elseIfClauses) {
          rewriteExprCalls(c.condition, rewriter);
          for (const s of c.body) rewriteStmtCalls(s, rewriter);
        }
      }
      if (stmt.elseBody) for (const s of stmt.elseBody) rewriteStmtCalls(s, rewriter);
      return;
    case "пока":
      rewriteExprCalls(stmt.condition, rewriter);
      for (const s of stmt.body) rewriteStmtCalls(s, rewriter);
      return;
    case "цикл":
      for (const s of stmt.body) rewriteStmtCalls(s, rewriter);
      return;
    case "для_каждого":
      rewriteExprCalls(stmt.source, rewriter);
      for (const s of stmt.body) rewriteStmtCalls(s, rewriter);
      return;
    case "вернуть":
      if (stmt.value) rewriteExprCalls(stmt.value, rewriter);
      return;
    case "попробовать":
      for (const s of stmt.body) rewriteStmtCalls(s, rewriter);
      for (const s of stmt.catchBody) rewriteStmtCalls(s, rewriter);
      return;
    case "выбросить":
      rewriteExprCalls(stmt.value, rewriter);
      return;
  }
}

function rewriteProcedureCalls(proc: Procedure, rewriter: (calleeName: string) => string): void {
  for (const s of proc.body) rewriteStmtCalls(s, rewriter);
}

function getFirstModuleOrThrow(program: Program | null): Module {
  if (!program || program.modules.length === 0) {
    throw new Error("Parser returned empty Program (no modules)");
  }
  return program.modules[0]!;
}

function parseModuleOrThrow(source: string): Module {
  const { tokens, errors: lexerErrors } = tokenize(source);
  const { ast: program, errors: parserErrors } = parse(tokens);
  if (lexerErrors.length > 0) throw new Error(lexerErrors[0]!.message);
  if (parserErrors.length > 0) throw new Error(parserErrors[0]!.message);
  return getFirstModuleOrThrow(program);
}

function expandModuleImports(
  ast: Module,
  baseDir: string,
  importStack: string[] = [],
  rootDir: string = baseDir,
): Module {
  const aliasToExportedProcNameToPrefixed = new Map<string, Map<string, string>>();
  const mergedTypeDeclarations: TypeDeclaration[] = [...ast.typeDeclarations];

  const inlinedProcedures: Procedure[] = [];
  for (const imp of ast.imports) {
    const resolved = resolveImportPath(imp.path, baseDir, rootDir);
    if (!fs.existsSync(resolved)) throw new Error(`Модуль не найден: ${imp.path}`);
    if (importStack.includes(resolved)) throw new Error(`Циклический импорт: ${imp.path}`);

    const importedSource = fs.readFileSync(resolved, "utf-8");
    const importedAst = parseModuleOrThrow(importedSource);
    const importedExpanded = expandModuleImports(
      importedAst,
      path.dirname(resolved),
      [...importStack, resolved],
      rootDir,
    );

    // Для внешних вызовов alias.proc доступны только процедуры, помеченные `экспорт` в импортируемом модуле.
    const exportedMap = new Map<string, string>();
    for (const p of importedExpanded.procedures) {
      if (p.exported) exportedMap.set(p.name, `${imp.module}__${p.name}`);
    }
    aliasToExportedProcNameToPrefixed.set(imp.module, exportedMap);

    // Инлайним (встраиваем) ВСЕ процедуры импортируемого модуля, переименовывая их с префиксом.
    const nameMap = new Map<string, string>();
    for (const p of importedExpanded.procedures) nameMap.set(p.name, `${imp.module}__${p.name}`);

    for (const p of importedExpanded.procedures) {
      const inlinedProc: Procedure = {
        name: nameMap.get(p.name)!,
        params: [...p.params],
        paramTypes: p.paramTypes ? [...p.paramTypes] : undefined,
        body: p.body,
        exported: undefined, // импортированные процедуры не экспортируются из текущего модуля
      };
      rewriteProcedureCalls(inlinedProc, (callee) => nameMap.get(callee) ?? callee);
      inlinedProcedures.push(inlinedProc);
    }

    // Типы из импортированного модуля доступны в текущем модуле.
    mergedTypeDeclarations.push(...importedExpanded.typeDeclarations);
  }

  // Переписываем вызовы Имя.процедура(...) в текущем модуле в уже инлайненные префиксные имена.
  for (const proc of ast.procedures) {
    rewriteProcedureCalls(proc, (callee) => {
      if (!callee.includes(".")) return callee;
      const [alias, rest] = callee.split(".", 2);
      const exportedByName = aliasToExportedProcNameToPrefixed.get(alias);
      if (!exportedByName) return callee; // не импортированный namespace
      const prefixed = exportedByName.get(rest ?? "");
      if (!prefixed) throw new Error("Процедура не экспортирована");
      return prefixed;
    });
  }

  return {
    name: ast.name,
    imports: [],
    typeDeclarations: mergedTypeDeclarations,
    procedures: [...ast.procedures, ...inlinedProcedures],
  };
}

/** Поля именованных типов: канон + синоним `Число` (парсер и few-shot допускают оба). */
const PRIMITIVE_FIELD_TYPES = new Set(["Целое32", "Число", "Строка", "Логический"]);

function primitiveAlias(name: string): string {
  if (name === "Целое32") return "Число";
  return name;
}

function typeRefKey(t: TypeRef): string {
  const base = primitiveAlias(t.name);
  return `${t.nullable ? "?" : ""}${t.array ? "[" : ""}${base}${t.array ? "]" : ""}`;
}

function typesCompatible(expected: TypeRef, actual: TypeRef): boolean {
  if (expected.nullable && actual.name === "пусто" && !actual.array) return true;
  if (actual.nullable && !expected.nullable) {
    // gradual: nullable actual into non-null expected — reject unless same after strip
  }
  if (!!expected.array !== !!actual.array) return false;
  return primitiveAlias(expected.name) === primitiveAlias(actual.name);
}

function validateNamedTypesAndRewrite(ast: Module): string[] {
  const errors: string[] = [];

  const typeByName = new Map<string, TypeDeclaration>();
  for (const td of ast.typeDeclarations) {
    if (!typeByName.has(td.name)) typeByName.set(td.name, td);
  }

  for (const td of ast.typeDeclarations) {
    if (td.variants && td.variants.length > 0) {
      if (td.fields.length > 0) {
        errors.push(`Тип ${td.name}: перечень не может иметь поля записи`);
      }
      const seen = new Set<string>();
      for (const v of td.variants) {
        if (seen.has(v)) errors.push(`Дубликат варианта ${v} в типе ${td.name}`);
        seen.add(v);
      }
      continue;
    }
    for (const f of td.fields) {
      if (!PRIMITIVE_FIELD_TYPES.has(f.type.name) && !typeByName.has(f.type.name)) {
        errors.push(`Неподдерживаемый тип поля: ${f.type.name}`);
      }
    }
  }

  function visitExprObjectLiteralRewrite(objExpr: Expr & { kind: "объект" }, typeName: string): void {
    const typeDef = typeByName.get(typeName);
    if (!typeDef || (typeDef.variants && typeDef.variants.length > 0)) return;

    const fieldByName = new Map(typeDef.fields.map((f) => [f.name, f]));
    const entries = objExpr.entries;
    const entryIndexByKey = new Map<string, number>();
    for (let i = 0; i < entries.length; i++) entryIndexByKey.set(entries[i]!.key, i);

    for (const entry of entries) {
      if (!fieldByName.has(entry.key)) {
        errors.push(`Неизвестное поле: ${entry.key} (тип ${typeName})`);
      }
    }

    for (const field of typeDef.fields) {
      const idx = entryIndexByKey.get(field.name);
      if (idx === undefined) {
        if (!field.type.nullable) {
          errors.push(`Отсутствует обязательное поле: ${field.name}`);
        } else {
          entries.push({ key: field.name, value: { kind: "пусто" } });
        }
      }
    }
  }

  /** `Масть.пики` (поле на имени перечня) → узел вариант. */
  function rewriteVariantLiteralsInExpr(expr: Expr): Expr {
    switch (expr.kind) {
      case "поле": {
        const obj = rewriteVariantLiteralsInExpr(expr.object);
        if (obj.kind === "переменная") {
          const td = typeByName.get(obj.name);
          if (td?.variants?.includes(expr.field)) {
            return { kind: "вариант", typeName: obj.name, variant: expr.field };
          }
        }
        return { kind: "поле", object: obj, field: expr.field };
      }
      case "бинарное":
        return {
          kind: "бинарное",
          op: expr.op,
          left: rewriteVariantLiteralsInExpr(expr.left),
          right: rewriteVariantLiteralsInExpr(expr.right),
        };
      case "унарное":
        return { kind: "унарное", op: expr.op, arg: rewriteVariantLiteralsInExpr(expr.arg) };
      case "вызов":
        return {
          kind: "вызов",
          name: expr.name,
          args: expr.args.map(rewriteVariantLiteralsInExpr),
        };
      case "массив":
        return { kind: "массив", elements: expr.elements.map(rewriteVariantLiteralsInExpr) };
      case "объект":
        return {
          kind: "объект",
          entries: expr.entries.map((e) => ({
            key: e.key,
            value: rewriteVariantLiteralsInExpr(e.value),
          })),
        };
      default:
        return expr;
    }
  }

  function rewriteVariantLiteralsInStmts(stmts: Stmt[]): void {
    for (let i = 0; i < stmts.length; i++) {
      const s = stmts[i]!;
      switch (s.kind) {
        case "пусть":
          stmts[i] = { ...s, init: rewriteVariantLiteralsInExpr(s.init) };
          break;
        case "присвоить":
          stmts[i] = { ...s, value: rewriteVariantLiteralsInExpr(s.value) };
          break;
        case "поле_присвоить":
          stmts[i] = {
            ...s,
            object: rewriteVariantLiteralsInExpr(s.object),
            value: rewriteVariantLiteralsInExpr(s.value),
          };
          break;
        case "выражение":
          stmts[i] = { ...s, expr: rewriteVariantLiteralsInExpr(s.expr) };
          break;
        case "если": {
          const elseIfClauses = s.elseIfClauses?.map((c) => {
            rewriteVariantLiteralsInStmts(c.body);
            return { condition: rewriteVariantLiteralsInExpr(c.condition), body: c.body };
          });
          rewriteVariantLiteralsInStmts(s.body);
          if (s.elseBody) rewriteVariantLiteralsInStmts(s.elseBody);
          stmts[i] = {
            ...s,
            condition: rewriteVariantLiteralsInExpr(s.condition),
            elseIfClauses,
          };
          break;
        }
        case "пока":
          stmts[i] = { ...s, condition: rewriteVariantLiteralsInExpr(s.condition) };
          rewriteVariantLiteralsInStmts(s.body);
          break;
        case "цикл":
          rewriteVariantLiteralsInStmts(s.body);
          break;
        case "для_каждого":
          stmts[i] = { ...s, source: rewriteVariantLiteralsInExpr(s.source) };
          rewriteVariantLiteralsInStmts(s.body);
          break;
        case "попробовать":
          rewriteVariantLiteralsInStmts(s.body);
          rewriteVariantLiteralsInStmts(s.catchBody);
          break;
        case "выбросить":
          stmts[i] = { ...s, value: rewriteVariantLiteralsInExpr(s.value) };
          break;
        case "вернуть":
          if (s.value) stmts[i] = { ...s, value: rewriteVariantLiteralsInExpr(s.value) };
          break;
        default:
          break;
      }
    }
  }

  for (const proc of ast.procedures) {
    rewriteVariantLiteralsInStmts(proc.body);
  }

  type Env = Map<string, TypeRef>;

  function inferExprType(expr: Expr, env: Env): TypeRef | undefined {
    switch (expr.kind) {
      case "число":
        return { name: "Число", nullable: false };
      case "строка":
        return { name: "Строка", nullable: false };
      case "булево":
        return { name: "Логический", nullable: false };
      case "пусто":
        return { name: "пусто", nullable: true };
      case "вариант":
        return { name: expr.typeName, nullable: false };
      case "переменная":
        return env.get(expr.name);
      case "поле": {
        const objT = inferExprType(expr.object, env);
        if (!objT || objT.array) return undefined;
        const td = typeByName.get(objT.name);
        if (!td || td.variants) return undefined;
        const field = td.fields.find((f) => f.name === expr.field);
        if (!field) {
          errors.push(`Неизвестное поле: ${expr.field} (тип ${objT.name})`);
          return undefined;
        }
        return field.type;
      }
      case "массив": {
        if (expr.elements.length === 0) return undefined;
        const first = inferExprType(expr.elements[0]!, env);
        if (!first) return undefined;
        return { name: first.name, nullable: false, array: true };
      }
      case "объект":
        return undefined;
      case "бинарное":
        if (expr.op === "==" || expr.op === "!=" || expr.op === "<" || expr.op === "<=" || expr.op === ">" || expr.op === ">=" || expr.op === "и" || expr.op === "или") {
          return { name: "Логический", nullable: false };
        }
        if (expr.op === "+") {
          const l = inferExprType(expr.left, env);
          const r = inferExprType(expr.right, env);
          if (l?.name === "Строка" || r?.name === "Строка") return { name: "Строка", nullable: false };
          return { name: "Число", nullable: false };
        }
        return { name: "Число", nullable: false };
      case "унарное":
        return { name: "Логический", nullable: false };
      case "вызов":
        return undefined;
      default:
        return undefined;
    }
  }

  function checkAssign(expected: TypeRef, actual: TypeRef | undefined, context: string): void {
    if (!actual) return; // gradual: неизвестный источник
    if (!typesCompatible(expected, actual)) {
      errors.push(`Несовпадение типа (${context}): ожидалось ${typeRefKey(expected)}, получено ${typeRefKey(actual)}`);
    }
  }

  function checkExprAgainst(expected: TypeRef | undefined, expr: Expr, env: Env, context: string): void {
    if (!expected) {
      inferExprType(expr, env); // всё равно ловим неизвестные поля
      return;
    }
    if (expr.kind === "объект" && !expected.array && typeByName.has(expected.name)) {
      const td = typeByName.get(expected.name)!;
      if (!td.variants) {
        visitExprObjectLiteralRewrite(expr, expected.name);
        for (const entry of expr.entries) {
          const field = td.fields.find((f) => f.name === entry.key);
          if (field) checkExprAgainst(field.type, entry.value, env, `${context}.${entry.key}`);
        }
        return;
      }
    }
    if (expr.kind === "массив" && expected.array) {
      const elemT: TypeRef = { name: expected.name, nullable: expected.nullable };
      for (const el of expr.elements) checkExprAgainst(elemT, el, env, `${context}[]`);
      return;
    }
    const actual = inferExprType(expr, env);
    checkAssign(expected, actual, context);
  }

  function checkStmtsTyped(stmts: Stmt[], env: Env, procByName: Map<string, Procedure>): void {
    for (const s of stmts) {
      switch (s.kind) {
        case "пусть": {
          if (s.typeAnnotation) {
            const typeName = s.typeAnnotation.name;
            if (!PRIMITIVE_FIELD_TYPES.has(typeName) && !typeByName.has(typeName) && typeName !== "пусто") {
              errors.push(`Тип не объявлен: ${typeName}`);
            }
            checkExprAgainst(s.typeAnnotation, s.init, env, s.name);
            env.set(s.name, s.typeAnnotation);
          } else {
            const inferred = inferExprType(s.init, env);
            if (inferred) env.set(s.name, inferred);
            else inferExprType(s.init, env);
          }
          break;
        }
        case "присвоить": {
          const expected = env.get(s.name);
          checkExprAgainst(expected, s.value, env, s.name);
          break;
        }
        case "поле_присвоить": {
          const objT = inferExprType(s.object, env);
          if (objT && !objT.array) {
            const td = typeByName.get(objT.name);
            if (td && !td.variants) {
              const field = td.fields.find((f) => f.name === s.field);
              if (!field) {
                errors.push(`Неизвестное поле: ${s.field} (тип ${objT.name})`);
              } else {
                checkExprAgainst(field.type, s.value, env, `${objT.name}.${s.field}`);
              }
            } else {
              inferExprType(s.value, env);
            }
          } else {
            inferExprType(s.value, env);
          }
          break;
        }
        case "выражение":
          inferExprType(s.expr, env);
          if (s.expr.kind === "вызов") {
            const callee = procByName.get(s.expr.name);
            if (callee?.paramTypes) {
              for (let i = 0; i < s.expr.args.length; i++) {
                const pt = callee.paramTypes[i];
                if (pt) checkExprAgainst(pt, s.expr.args[i]!, env, `${s.expr.name}#${i}`);
              }
            }
          }
          break;
        case "если":
          inferExprType(s.condition, env);
          checkStmtsTyped(s.body, new Map(env), procByName);
          if (s.elseIfClauses) {
            for (const c of s.elseIfClauses) {
              inferExprType(c.condition, env);
              checkStmtsTyped(c.body, new Map(env), procByName);
            }
          }
          if (s.elseBody) checkStmtsTyped(s.elseBody, new Map(env), procByName);
          break;
        case "пока":
          inferExprType(s.condition, env);
          checkStmtsTyped(s.body, env, procByName);
          break;
        case "цикл":
          checkStmtsTyped(s.body, env, procByName);
          break;
        case "для_каждого": {
          inferExprType(s.source, env);
          const srcT = inferExprType(s.source, env);
          const bodyEnv = new Map(env);
          if (srcT?.array) {
            bodyEnv.set(s.item, { name: srcT.name, nullable: srcT.nullable });
          }
          if (s.index) bodyEnv.set(s.index, { name: "Число", nullable: false });
          checkStmtsTyped(s.body, bodyEnv, procByName);
          break;
        }
        case "попробовать":
          checkStmtsTyped(s.body, env, procByName);
          {
            const catchEnv = new Map(env);
            catchEnv.set(s.catchVar, { name: "Строка", nullable: true });
            checkStmtsTyped(s.catchBody, catchEnv, procByName);
          }
          break;
        case "выбросить":
          inferExprType(s.value, env);
          break;
        case "вернуть":
          if (s.value) {
            if (s.value.kind === "вызов") {
              const callee = procByName.get(s.value.name);
              if (callee?.paramTypes) {
                for (let i = 0; i < s.value.args.length; i++) {
                  const pt = callee.paramTypes[i];
                  if (pt) checkExprAgainst(pt, s.value.args[i]!, env, `${s.value.name}#${i}`);
                }
              }
            }
            inferExprType(s.value, env);
          }
          break;
        default:
          break;
      }
    }
  }

  // Первый проход: литералы пусть мир: Мир = {…} (как раньше).
  function visitStmtsLiteralPass(stmts: Stmt[]): void {
    for (const s of stmts) {
      switch (s.kind) {
        case "пусть": {
          if (!s.typeAnnotation) break;
          const typeName = s.typeAnnotation.name;
          const typeDef = typeByName.get(typeName);
          if (!typeDef && !PRIMITIVE_FIELD_TYPES.has(typeName)) {
            errors.push(`Тип не объявлен: ${typeName}`);
            break;
          }
          if (typeDef?.variants) {
            if (s.init.kind === "объект") {
              errors.push(`Тип ${typeName} — перечень, не запись`);
            }
            break;
          }
          if (s.init.kind === "объект" && typeDef) {
            visitExprObjectLiteralRewrite(s.init, typeName);
          }
          break;
        }
        case "если":
          visitStmtsLiteralPass(s.body);
          if (s.elseIfClauses) for (const c of s.elseIfClauses) visitStmtsLiteralPass(c.body);
          if (s.elseBody) visitStmtsLiteralPass(s.elseBody);
          break;
        case "пока":
        case "цикл":
          visitStmtsLiteralPass(s.body);
          break;
        case "для_каждого":
          visitStmtsLiteralPass(s.body);
          break;
        case "попробовать":
          visitStmtsLiteralPass(s.body);
          visitStmtsLiteralPass(s.catchBody);
          break;
        default:
          break;
      }
    }
  }

  visitStmtsLiteralPass(ast.procedures.flatMap((p) => p.body));

  const procByName = new Map(ast.procedures.map((p) => [p.name, p]));
  for (const proc of ast.procedures) {
    const env: Env = new Map();
    for (let i = 0; i < proc.params.length; i++) {
      const pt = proc.paramTypes?.[i];
      if (pt) env.set(proc.params[i]!, pt);
    }
    checkStmtsTyped(proc.body, env, procByName);
  }

  // Также проверяем вызовы как выражения (не только в вернуть/выражение).
  function checkCallsInExpr(expr: Expr, env: Env): void {
    switch (expr.kind) {
      case "вызов": {
        const callee = procByName.get(expr.name);
        if (callee?.paramTypes) {
          for (let i = 0; i < expr.args.length; i++) {
            const pt = callee.paramTypes[i];
            if (pt) checkExprAgainst(pt, expr.args[i]!, env, `${expr.name}#${i}`);
            else checkCallsInExpr(expr.args[i]!, env);
          }
        } else {
          for (const a of expr.args) checkCallsInExpr(a, env);
        }
        break;
      }
      case "бинарное":
        checkCallsInExpr(expr.left, env);
        checkCallsInExpr(expr.right, env);
        break;
      case "унарное":
        checkCallsInExpr(expr.arg, env);
        break;
      case "поле":
        checkCallsInExpr(expr.object, env);
        break;
      case "массив":
        for (const el of expr.elements) checkCallsInExpr(el, env);
        break;
      case "объект":
        for (const e of expr.entries) checkCallsInExpr(e.value, env);
        break;
      default:
        break;
    }
  }

  function checkCallsInStmts(stmts: Stmt[], env: Env): void {
    for (const s of stmts) {
      switch (s.kind) {
        case "пусть":
          checkCallsInExpr(s.init, env);
          if (s.typeAnnotation) env.set(s.name, s.typeAnnotation);
          else {
            const inf = inferExprType(s.init, env);
            if (inf) env.set(s.name, inf);
          }
          break;
        case "присвоить":
          checkCallsInExpr(s.value, env);
          break;
        case "поле_присвоить":
          checkCallsInExpr(s.object, env);
          checkCallsInExpr(s.value, env);
          break;
        case "выражение":
          checkCallsInExpr(s.expr, env);
          break;
        case "если":
          checkCallsInExpr(s.condition, env);
          checkCallsInStmts(s.body, new Map(env));
          if (s.elseIfClauses) for (const c of s.elseIfClauses) {
            checkCallsInExpr(c.condition, env);
            checkCallsInStmts(c.body, new Map(env));
          }
          if (s.elseBody) checkCallsInStmts(s.elseBody, new Map(env));
          break;
        case "пока":
          checkCallsInExpr(s.condition, env);
          checkCallsInStmts(s.body, env);
          break;
        case "цикл":
          checkCallsInStmts(s.body, env);
          break;
        case "для_каждого":
          checkCallsInExpr(s.source, env);
          checkCallsInStmts(s.body, env);
          break;
        case "попробовать":
          checkCallsInStmts(s.body, env);
          checkCallsInStmts(s.catchBody, env);
          break;
        case "выбросить":
          checkCallsInExpr(s.value, env);
          break;
        case "вернуть":
          if (s.value) checkCallsInExpr(s.value, env);
          break;
        default:
          break;
      }
    }
  }

  for (const proc of ast.procedures) {
    const env: Env = new Map();
    for (let i = 0; i < proc.params.length; i++) {
      const pt = proc.paramTypes?.[i];
      if (pt) env.set(proc.params[i]!, pt);
    }
    checkCallsInStmts(proc.body, env);
  }

  return errors;
}

/** IR (промежуточное представление) MVP — тот же контейнер, что и байткод v1 (.osvbc). */
export type OsnovaIrModule = OsVbcModule;

function remapConstKInInstruction(ins: RawInstruction, oldToNew: number[]): RawInstruction {
  if (ins.op === "const" && "k" in ins) {
    const k = (ins as { k: number }).k;
    const nk = oldToNew[k];
    if (nk === undefined) return ins;
    return { ...ins, k: nk } as RawInstruction;
  }
  return ins;
}

function remapCodeElements(code: CodeElement[], oldToNew: number[]): CodeElement[] {
  return code.map((el) => {
    if (isVliwPacket(el)) {
      return {
        ...el,
        slots: el.slots.map((s) => remapConstKInInstruction(s, oldToNew)),
      };
    }
    return remapConstKInInstruction(el as RawInstruction, oldToNew);
  });
}

/**
 * Оптимизация IR: слияние дублирующихся литералов в пуле констант и перенумерация const.k.
 * Длину кода и смещения jmp не меняет — безопасно для последовательной VM.
 */
export function optimizeIrModule(ir: OsVbcModule): OsVbcModule {
  const oldConsts = ir.constants;
  if (oldConsts.length <= 1) return ir;

  const oldToNew: number[] = new Array(oldConsts.length);
  const newConsts: unknown[] = [];
  for (let i = 0; i < oldConsts.length; i++) {
    const v = oldConsts[i]!;
    let found = -1;
    for (let j = 0; j < newConsts.length; j++) {
      if (Object.is(v, newConsts[j])) {
        found = j;
        break;
      }
    }
    if (found >= 0) {
      oldToNew[i] = found;
    } else {
      oldToNew[i] = newConsts.length;
      newConsts.push(v);
    }
  }

  if (newConsts.length === oldConsts.length) return ir;

  return {
    ...ir,
    constants: newConsts,
    code: remapCodeElements(ir.code, oldToNew),
  };
}

export function compileSource(source: string, options: CompileOptions = {}): CompileResult {
  const start = Date.now();
  const logs: CompileLog[] = [];
  const { tokens, errors: lexerErrors } = tokenize(source);
  const { ast: program, errors: parserErrors } = parse(tokens);

  // Логирование ошибок лексера
  for (const err of lexerErrors) {
    addLog(logs, 'error', 'lexer', err.message, start, toCompileError(err, err.line, err.column, 'lexer_error'));
  }

  // Логирование ошибок парсера
  for (const err of parserErrors) {
    addLog(logs, 'error', 'parser', err.message, start, toCompileError(err, err.line, undefined, 'parser_error'));
  }

  if (lexerErrors.length > 0 || parserErrors.length > 0 || !program || program.modules.length === 0) {
    return {
      module: null,
      modules: [],
      compilerSuccess: false,
      lexerErrors,
      parserErrors,
      compilerErrors: [],
      semanticErrors: [],
      durationMs: Date.now() - start,
      logs,
    };
  }

  const baseDir = options.baseDir ?? process.cwd();

  let expandedAst: Module;
  try {
    const ast = getFirstModuleOrThrow(program);
    expandedAst = expandModuleImports(ast, baseDir, [], baseDir);
  } catch (e) {
    const errorMsg = e instanceof Error ? e.message : String(e);
    addLog(logs, 'error', 'codegen', errorMsg, start, toCompileError(e instanceof Error ? e : { message: errorMsg }, undefined, undefined, 'import_error'));
    return {
      module: null,
      modules: [],
      compilerSuccess: false,
      lexerErrors: [],
      parserErrors: [],
      compilerErrors: [{ message: errorMsg }],
      semanticErrors: [],
      durationMs: Date.now() - start,
      logs,
    };
  }

  let namedTypeErrors: string[];
  if (program.modules.length === 1) {
    namedTypeErrors = validateNamedTypesAndRewrite(expandedAst);
  } else {
    namedTypeErrors = [];
    for (const mod of program.modules) {
      try {
        const ex = expandModuleImports(mod, baseDir, [], baseDir);
        namedTypeErrors.push(...validateNamedTypesAndRewrite(ex));
      } catch (e) {
        namedTypeErrors.push(e instanceof Error ? e.message : String(e));
      }
    }
  }
  if (namedTypeErrors.length > 0) {
    for (const msg of namedTypeErrors) {
      addLog(logs, 'error', 'codegen', msg, start, toCompileError({ message: msg }, undefined, undefined, 'type_error'));
    }
    return {
      module: null,
      modules: [],
      compilerSuccess: false,
      lexerErrors: [],
      parserErrors: [],
      compilerErrors: namedTypeErrors.map((message) => ({ message })),
      semanticErrors: [],
      durationMs: Date.now() - start,
      logs,
    };
  }

  const semanticErrors = analyzeProgram(
    { modules: [expandedAst] },
    { extraSyscalls: options.extraSyscalls },
  ).errors;
  const semanticAsCompiler = semanticErrors.map((e) => ({ message: `[semantic] ${e.message}` }));

  // Логирование семантических ошибок
  for (const err of semanticErrors) {
    addLog(logs, 'warn', 'semantic', err.message, start, toCompileError({ message: err.message }, err.line, undefined, err.kind));
  }

  if (program.modules.length > 1) {
    const programSemanticErrors = analyzeProgram(program, {
      extraSyscalls: options.extraSyscalls,
    }).errors;
    const programSemanticAsCompiler = programSemanticErrors.map((e) => ({ message: `[semantic] ${e.message}` }));
    try {
      const compiledModules = compileProgram(program).map(optimizeIrModule);
      return {
        module: compiledModules[0] ?? null,
        modules: compiledModules,
        compilerSuccess: true,
        lexerErrors: [],
        parserErrors: [],
        compilerErrors: programSemanticAsCompiler,
        semanticErrors: programSemanticErrors,
        durationMs: Date.now() - start,
        logs,
      };
    } catch (e) {
      const errorMsg = e instanceof Error ? e.message : String(e);
      addLog(logs, 'error', 'codegen', errorMsg, start, toCompileError(e instanceof Error ? e : { message: errorMsg }, undefined, undefined, 'codegen_error'));
      return {
        module: null,
        modules: [],
        compilerSuccess: false,
        lexerErrors: [],
        parserErrors: [],
        compilerErrors: [
          ...programSemanticAsCompiler,
          { message: errorMsg },
        ],
        semanticErrors: programSemanticErrors,
        durationMs: Date.now() - start,
        logs,
      };
    }
  }

  try {
    const module = optimizeIrModule(compile(expandedAst));
    return {
      module,
      modules: [module],
      compilerSuccess: true,
      lexerErrors: [],
      parserErrors: [],
      compilerErrors: semanticAsCompiler,
      semanticErrors,
      durationMs: Date.now() - start,
      logs,
    };
  } catch (e) {
    const errorMsg = e instanceof Error ? e.message : String(e);
    addLog(logs, 'error', 'codegen', errorMsg, start, toCompileError(e instanceof Error ? e : { message: errorMsg }, undefined, undefined, 'codegen_error'));
    return {
      module: null,
      modules: [],
      compilerSuccess: false,
      lexerErrors: [],
      parserErrors: [],
      compilerErrors: [
        ...semanticAsCompiler,
        { message: errorMsg },
      ],
      semanticErrors,
      durationMs: Date.now() - start,
      logs,
    };
  }
}

/**
 * Адаптер: CompileResult (src/compiler/compiler.ts) → BuildReport (src/pipeline/types.ts).
 * Каноническая реализация — та же логика, что {@link import("../pipeline/orchestrator").compileToBuildReport}
 * (orchestrator реэкспортирует отсюда, чтобы не дублировать список blocking kinds).
 *
 * Разница:
 *   CompileResult.module → BuildReport.bytecode
 *   BuildReport.success = compilerSuccess && пустые lexer/parser && нет blocking semantic (см. {@link BLOCKING_SEMANTIC_KINDS})
 */
export function compileToBuildReport(r: CompileResult): BuildReport {
  const blockingSemanticErrors = (r.semanticErrors ?? []).filter(
    e => (BLOCKING_SEMANTIC_KINDS as readonly string[]).includes(e.kind),
  );
  return {
    success:
      r.compilerSuccess &&
      r.lexerErrors.length === 0 &&
      r.parserErrors.length === 0 &&
      blockingSemanticErrors.length === 0,
    lexerErrors: r.lexerErrors,
    parserErrors: r.parserErrors,
    compilerErrors: r.compilerErrors,
    semanticErrors: r.semanticErrors ?? [],
    semanticErrorCount: (r.semanticErrors ?? []).length,
    bytecode: r.module ?? null,
    compilerSuccess: r.compilerSuccess,
    durationMs: r.durationMs,
  } satisfies BuildReport;
}

/**
 * Сводка ошибок, когда сборка не считается успешной по {@link compileToBuildReport}
 * (включая блокирующие semantic). Пустая строка при `report.success`.
 */
export function formatCompileFailureMessage(result: CompileResult): string {
  const report = compileToBuildReport(result);
  if (report.success) return '';
  const parts: string[] = [
    ...result.lexerErrors.map((e) => e.message),
    ...result.parserErrors.map((e) => e.message),
    ...result.compilerErrors.map((e) => e.message),
    ...result.semanticErrors.map((e) => e.message),
  ];
  return parts.length > 0 ? parts.join('; ') : 'compilation failed';
}
