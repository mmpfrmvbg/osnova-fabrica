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

import { tokenize, type LexerError } from './lexer';
import { parse, type ParseError, type ParseWarning } from './parser';
import { compile, compileProgram } from './codegen';
import { isVliwPacket, type CodeElement, type OsVbcModule, type RawInstruction } from '../runtime/vm/bytecode';
import { OsVbcVM, type OsVbcVMOptions, type StackValue } from '../runtime/vm';
import { InterpreterError } from '../runtime/vm/interpreter';
import { RUNTIME_CODES } from '../runtime/runtimeCodes';
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
  /** Файл исходника (вход или импорт), если известен */
  file?: string;
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
  /**
   * Расширенный AST главного модуля — точно тот, что ушёл в стековый кодоген
   * (импорты развёрнуты, `когда` снят, типы развёрнуты и дописаны литералы).
   * Нужен альтернативным бэкендам (регистровый, `src/oracle/parity.ts`): они
   * обязаны компилировать **тот же** AST, что эталон, иначе сверка бессмысленна.
   * Не заполняется, если ошибка случилась до кодогена (лексер/парсер).
   */
  moduleAst?: Module;
  /** true если компилятор отработал без ошибок */
  compilerSuccess: boolean;
  /** Ошибки лексера */
  lexerErrors: { message: string; line: number; column: number }[];
  /** Ошибки парсера */
  parserErrors: ParseError[];
  /** Ошибки компилятора (codegen-фаза, импорт, дубликат типа) */
  compilerErrors: { message: string; node?: string; file?: string; line?: number; column?: number }[];
  /** Ошибки семантического анализатора (предупреждения первого этапа) */
  semanticErrors: SemanticError[];
  /**
   * Предупреждения компиляции. **Не** влияют на `compilerSuccess` и на
   * `BuildReport.success`: это информация, а не отказ (Стадия 2 плана v2 —
   * устаревшее закрывающее `конец`). Пусто, если предупреждения не запрошены
   * ({@link CompileOptions.warnDeprecated}).
   */
  warnings: ParseWarning[];
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
  /** Имя входного файла для диагностики (например `игра.osnova`). */
  filename?: string;
  /**
   * ФРОНТЕНД (внедряется снаружи, по умолчанию — v2).
   *
   * Зачем параметр, а не импорт: конвейер компилятора не должен знать, каким
   * синтаксисом написан исходник. v3-фронтенд (`src/compiler-v3`) выдаёт тот же
   * `Module` формы v2 и подставляет себя здесь — тогда ВЕСЬ путь (`semantic` →
   * кодоген → `regcodegen` → `vliw` → `e2k` → ELF) идёт без единой копии.
   * Обратный импорт (`compiler` → `compiler-v3`) дал бы петлю и второй путь.
   */
  parse?: (source: string, filename: string) => { ast: Program | null; errors: string[] };
  /**
   * Хост-вызовы вне `система.*` (например `игра.очистить`).
   * Проверяются как syscall (имя + argc). Не добавляются в language-registry.
   */
  extraSyscalls?: HostSyscallSpec[];
  /**
   * Включить предупреждения об устаревших конструкциях. По умолчанию
   * **выключено**: корпус и примеры ещё на legacy-закрытиях `конец`, и молчание
   * по умолчанию — часть Стадии 2 (массовая миграция — после выкладки 0.1).
   * Включается флагом CLI `--warn-deprecated` и шагом CI.
   */
  warnDeprecated?: boolean;
}

/** Ошибка разворачивания импорта: файл и место, не только текст. */
class ImportExpandError extends Error {
  file?: string;
  line?: number;
  column?: number;
  constructor(
    message: string,
    loc?: { file?: string; line?: number; column?: number },
  ) {
    super(message);
    this.name = "ImportExpandError";
    this.file = loc?.file;
    this.line = loc?.line;
    this.column = loc?.column;
  }
}

function compilerErrorFromCaught(e: unknown): {
  message: string;
  file?: string;
  line?: number;
  column?: number;
} {
  if (e instanceof ImportExpandError) {
    return { message: e.message, file: e.file, line: e.line, column: e.column };
  }
  return { message: e instanceof Error ? e.message : String(e) };
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
    const result = this.compile(source, {
      baseDir,
      filename: options.filename,
      extraSyscalls: options.extraSyscalls,
    });
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
        // Код назван так же, как у одноимённого пути в интерпретаторе: без него
        // запись отказа в журнале получила бы `OSN-RT-000` («код не назван») и
        // выглядела бы разрывом канала, хотя причина известна (замер T2, 2026-09-28).
        throw new InterpreterError(
          `Invalid procedure index: ${procedureIndex}`,
          undefined,
          undefined,
          RUNTIME_CODES.entryNotFound,
        );
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
  error: Error | { message: string; file?: string; line?: number; column?: number },
  line?: number,
  column?: number,
  kind?: string
): CompileError {
  const withFile = error as { message: string; file?: string; line?: number; column?: number };
  return {
    message: error.message,
    file: withFile.file,
    line: line ?? withFile.line,
    column: column ?? withFile.column,
    kind,
  };
}

function displayPath(absPath: string, rootDir: string): string {
  const rel = path.relative(path.resolve(rootDir), path.resolve(absPath));
  return rel.split(path.sep).join("/");
}

function resolveImportPath(importPath: string, baseDir: string, rootDir: string): string {
  if (path.isAbsolute(importPath)) {
    throw new ImportExpandError(`Импорт только относительный: ${importPath}`);
  }
  const resolved = path.resolve(baseDir, importPath);
  const root = path.resolve(rootDir);
  const rel = path.relative(root, resolved);
  if (rel.startsWith("..") || path.isAbsolute(rel)) {
    throw new ImportExpandError(`Импорт вне каталога: ${importPath}`);
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
    case "когда":
      rewriteExprCalls(stmt.scrutinee, rewriter);
      for (const arm of stmt.arms) {
        rewriteExprCalls(arm.variant, rewriter);
        for (const s of arm.body) rewriteStmtCalls(s, rewriter);
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

function parseModuleOrThrow(source: string, file: string): Module {
  const { tokens, errors: lexerErrors } = tokenize(source);
  // Импортируемый файл — такой же файл-модуль (БЛОК 3, пункт 1): имя модуля
  // берётся из имени ЭТОГО файла, а не из имени входного.
  const { ast: program, errors: parserErrors } = parse(tokens, { filename: file });
  if (lexerErrors.length > 0) {
    const e = lexerErrors[0]!;
    throw new ImportExpandError(e.message, { file, line: e.line, column: e.column });
  }
  if (parserErrors.length > 0) {
    const e = parserErrors[0]!;
    throw new ImportExpandError(e.message, { file, line: e.line, column: e.column });
  }
  return getFirstModuleOrThrow(program);
}

function expandModuleImports(
  ast: Module,
  baseDir: string,
  importStack: string[] = [],
  rootDir: string = baseDir,
  currentFile: string = "вход",
): Module {
  const aliasToExportedProcNameToPrefixed = new Map<string, Map<string, string>>();
  const seenTypeOrigin = new Map<string, string>();
  const mergedTypeDeclarations: TypeDeclaration[] = [];

  const ownNames = new Set<string>();
  for (const td of ast.typeDeclarations) {
    if (ownNames.has(td.name)) {
      throw new ImportExpandError(`Тип ${td.name} объявлен дважды`, { file: currentFile });
    }
    ownNames.add(td.name);
    seenTypeOrigin.set(td.name, currentFile);
    mergedTypeDeclarations.push({ ...td, origin: currentFile });
  }

  const inlinedProcedures: Procedure[] = [];
  for (const imp of ast.imports) {
    let resolved: string;
    try {
      resolved = resolveImportPath(imp.path, baseDir, rootDir);
    } catch (e) {
      if (e instanceof ImportExpandError) {
        throw new ImportExpandError(e.message, { file: currentFile });
      }
      throw e;
    }
    const importDisplay = displayPath(resolved, rootDir);
    if (!fs.existsSync(resolved)) {
      throw new ImportExpandError(`Модуль не найден: ${imp.path}`, { file: currentFile });
    }
    if (importStack.includes(resolved)) {
      throw new ImportExpandError(`Циклический импорт: ${imp.path}`, { file: currentFile });
    }

    const importedSource = fs.readFileSync(resolved, "utf-8");
    const importedAst = parseModuleOrThrow(importedSource, importDisplay);
    const importedExpanded = expandModuleImports(
      importedAst,
      path.dirname(resolved),
      [...importStack, resolved],
      rootDir,
      importDisplay,
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
        returnType: p.returnType,
        pure: p.pure,
        body: p.body,
        exported: undefined, // импортированные процедуры не экспортируются из текущего модуля
        // Файл, откуда процедура пришла: без него диагностика внутри встроенной
        // процедуры называла бы сборкой ГЛАВНОГО модуля. Ровно так терялась
        // ошибка `модуль 'ЗадачиПриоритеты' не найден` из tasks_core.osnova.
        origin: p.origin ?? importDisplay,
      };
      rewriteProcedureCalls(inlinedProc, (callee) => nameMap.get(callee) ?? callee);
      inlinedProcedures.push(inlinedProc);
    }

    for (const td of importedExpanded.typeDeclarations) {
      const origin = td.origin ?? importDisplay;
      const prev = seenTypeOrigin.get(td.name);
      if (prev === undefined) {
        seenTypeOrigin.set(td.name, origin);
        mergedTypeDeclarations.push({ ...td, origin });
        continue;
      }
      if (prev !== origin) {
        throw new ImportExpandError(`Тип ${td.name} объявлен в ${prev} и в ${origin}`, {
          file: currentFile,
        });
      }
    }
  }

  // Переписываем вызовы Имя.процедура(...) в текущем модуле в уже инлайненные префиксные имена.
  for (const proc of ast.procedures) {
    rewriteProcedureCalls(proc, (callee) => {
      if (!callee.includes(".")) return callee;
      const [alias, rest] = callee.split(".", 2);
      const exportedByName = aliasToExportedProcNameToPrefixed.get(alias);
      if (!exportedByName) return callee; // не импортированный namespace
      const prefixed = exportedByName.get(rest ?? "");
      if (!prefixed) {
        throw new ImportExpandError(`Процедура ${alias}.${rest ?? ""} не экспортирована`, {
          file: currentFile,
        });
      }
      return prefixed;
    });
  }

  return {
    name: ast.name,
    imports: [],
    typeDeclarations: mergedTypeDeclarations,
    // Каждой процедуре проставляется ФАЙЛ, из которого она пришла. Свои —
    // входной файл, встроенные — тот, откуда их принесли. Иначе диагностика
    // (semantic.ts) называла бы сборкой главного ошибку, возникшую в чужом
    // модуле: так и было с `модуль 'X' не найден` из `tasks_core.osnova`.
    procedures: [
      ...ast.procedures.map((p) => ({ ...p, origin: p.origin ?? currentFile })),
      ...inlinedProcedures.map((p) => ({ ...p, origin: p.origin ?? currentFile })),
    ],
  };
}

/**
 * Поля именованных типов: канон + синонимы, сводящиеся к `Число`.
 *
 * `Целое32` и `Целое64` — не отдельные типы, а **аннотации**: оба сводятся к
 * `Число` (`primitiveAlias`), арифметика одна, float64. Отдельной 32/64-битной
 * арифметики с обёрткой в языке НЕТ — это объявлено в каноне (§13.5) и
 * закреплено оракулом `src/compiler/canon.test.ts` равенством БАЙТКОДА программ
 * с аннотацией и без неё: если бы аннотация что-то значила для кодогена, байткод
 * разошёлся бы.
 */
const PRIMITIVE_FIELD_TYPES = new Set(["Целое32", "Целое64", "Число", "Строка", "Логический"]);

function primitiveAlias(name: string): string {
  if (name === "Целое32" || name === "Целое64") return "Число";
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

/**
 * Приводит AST к виду, который ждут кодогены: проверяет именованные типы и
 * РАЗРЕШАЕТ нейтральные имена (`длина` — по типу операнда: строка или список).
 *
 * Экспортируется для v3-фронтенда: он отдаёт тот же AST, и ему нужен тот же
 * проход. Порядок обязателен — до семантики и кодогена, иначе `длина` дойдёт до
 * них как неизвестное имя.
 */
export function validateNamedTypesAndRewrite(ast: Module): string[] {
  const errors: string[] = [];

  const typeByName = new Map<string, TypeDeclaration>();
  for (const td of ast.typeDeclarations) {
    if (!typeByName.has(td.name)) typeByName.set(td.name, td);
  }

  // Тип возврата каждой процедуры (аннотация `: Тип` или вывод из `вернуть`).
  // Объявляем до inferExprType, чтобы вывод `вернуть f()` мог замкнуть эту карту.
  const returnTypeByProc = new Map<string, TypeRef>();

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
        case "когда": {
          for (const arm of s.arms) rewriteVariantLiteralsInStmts(arm.body);
          if (s.elseBody) rewriteVariantLiteralsInStmts(s.elseBody);
          stmts[i] = {
            ...s,
            scrutinee: rewriteVariantLiteralsInExpr(s.scrutinee),
            arms: s.arms.map((arm) => ({
              variant: rewriteVariantLiteralsInExpr(arm.variant),
              body: arm.body,
            })),
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

  /**
   * ТИП ВОЗВРАТА СИСТЕМНОГО ВЫЗОВА — то, чего до этой правки не знал никто.
   *
   * # Почему это понадобилось именно здесь
   *
   * `inferExprType` выводил тип только для СВОИХ процедур (`returnTypeByProc`), а системные вызовы
   * возвращали `undefined`. Пока это никого не задевало, потому что типы системных значений почти
   * нигде не спрашиваются. Но `длина` спрашивает — и это её смысл: она выбирает реализацию по типу
   * операнда, а при невыведенном типе ОТКАЗЫВАЕТ (названный отказ, а не догадка).
   *
   * Замер, который это показал (первый прогон `src/self-host/stringIndex.test.ts`):
   * `пусть знак = с[1]` + `длина знак` → ««длина» требует известного типа операнда: у «знак» тип не
   * выведен». То есть СИМВОЛ СТРОКИ был получен, а его длина — уже нет: законная программа
   * отвергалась из-за пробела в выводе типов, а не из-за своего дефекта.
   *
   * # Границы карты
   *
   * Здесь только те вызовы, чей тип возврата ОПРЕДЕЛЁН каноном и не зависит от аргументов. Чего
   * здесь нет намеренно: `система.массив.получить` (тип элемента известен только по типу массива —
   * это вывод по контейнеру, отдельная работа), `система.json.*` (значение любого типа),
   * `система.оценить` (то же). Пустое место честнее догадки: неизвестный тип остаётся `undefined`,
   * и `длина` от него отказывает, как и раньше.
   */
  function syscallReturnType(name: string): TypeRef | undefined {
    switch (name) {
      case "система.строка.подстрока":
      case "система.строка.объединить":
      case "система.строка.из_числа":
      case "система.строка.в_верхний":
      case "система.строка.в_нижний":
      case "система.строка.обрезать":
      case "система.строка.заменить":
        return { name: "Строка", nullable: false };
      case "система.строка.длина":
      case "система.строка.найти":
      // КОД СИМВОЛА, а не символ-строка (решение владельца 2026-10-10, §3.133): строковая модель
      // цели требует известной на СБОРКЕ длины, а `с[и]` по рантаймовому индексу даёт 1–4 байта,
      // известных только в рантайме. Прежде здесь стояла Строка — и `с[0] + 100` склеивало.
      case "система.строка.символ":
      case "система.массив.длина":
        return { name: "Число", nullable: false };
      // Файловые операции: `читать` даёт Строку, `открыть` — дескриптор-Число. Без этих двух строк
      // `длина читать(д, 100)` отверглась бы с «тип не выведен» — ровно так уже было у символа
      // строки, и разбор этого случая — в шапке `syscallReturnType`.
      case "система.файлы.читать":
        return { name: "Строка", nullable: false };
      case "система.файлы.открыть":
      case "система.файлы.писать":
        return { name: "Число", nullable: false };
      default:
        return undefined;
    }
  }

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
        return syscallReturnType(expr.name) ?? returnTypeByProc.get(expr.name);
      default:
        return undefined;
    }
  }

  // ─── вывод типа возврата процедур из `вернуть` ───
  function collectReturnTypes(stmts: Stmt[], env: Env, out: TypeRef[]): void {
    for (const s of stmts) {
      switch (s.kind) {
        case "вернуть":
          if (s.value) {
            const t = inferExprType(s.value, env);
            if (t) out.push(t);
          }
          break;
        case "пусть": {
          if (s.typeAnnotation) env.set(s.name, s.typeAnnotation);
          else {
            const t = inferExprType(s.init, env);
            if (t) env.set(s.name, t);
          }
          break;
        }
        case "если":
          collectReturnTypes(s.body, new Map(env), out);
          if (s.elseIfClauses) for (const c of s.elseIfClauses) collectReturnTypes(c.body, new Map(env), out);
          if (s.elseBody) collectReturnTypes(s.elseBody, new Map(env), out);
          break;
        case "пока":
        case "цикл":
          collectReturnTypes(s.body, new Map(env), out);
          break;
        case "для_каждого": {
          const srcT = inferExprType(s.source, env);
          const bodyEnv = new Map(env);
          if (srcT?.array) bodyEnv.set(s.item, { name: srcT.name, nullable: srcT.nullable });
          if (s.index) bodyEnv.set(s.index, { name: "Число", nullable: false });
          collectReturnTypes(s.body, bodyEnv, out);
          break;
        }
        case "попробовать":
          collectReturnTypes(s.body, new Map(env), out);
          collectReturnTypes(s.catchBody, new Map(env), out);
          break;
        default:
          break;
      }
    }
  }

  // Сначала аннотированные типы возврата, затем вывод из простых `вернуть`.
  for (const proc of ast.procedures) {
    if (proc.returnType) returnTypeByProc.set(proc.name, proc.returnType);
  }
  for (const proc of ast.procedures) {
    if (returnTypeByProc.has(proc.name)) continue;
    const env: Env = new Map();
    for (let i = 0; i < proc.params.length; i++) {
      const pt = proc.paramTypes?.[i];
      if (pt) env.set(proc.params[i]!, pt);
    }
    const rets: TypeRef[] = [];
    collectReturnTypes(proc.body, env, rets);
    if (rets.length > 0 && rets.every((t) => typeRefKey(t) === typeRefKey(rets[0]!))) {
      returnTypeByProc.set(proc.name, rets[0]!);
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

  function desugarKogda(stmt: Stmt & { kind: "когда" }): Stmt {
    const first = stmt.arms[0]!;
    const eq = (variant: Expr): Expr => ({
      kind: "бинарное",
      op: "==",
      left: stmt.scrutinee,
      right: variant,
    });
    const elseIfClauses = stmt.arms.slice(1).map((arm) => ({
      condition: eq(arm.variant),
      body: arm.body,
    }));
    return {
      kind: "если",
      condition: eq(first.variant),
      body: first.body,
      elseIfClauses: elseIfClauses.length > 0 ? elseIfClauses : undefined,
      elseBody: stmt.elseBody,
    };
  }

  function checkKogda(stmt: Stmt & { kind: "когда" }): void {
    if (stmt.arms.length === 0) {
      errors.push("когда: нужна хотя бы одна ветка есть");
      return;
    }
    let typeName = "";
    const seen = new Set<string>();
    for (const arm of stmt.arms) {
      if (arm.variant.kind !== "вариант") {
        errors.push("когда: в есть нужен литерал перечня Имя.вариант");
        continue;
      }
      if (!typeName) typeName = arm.variant.typeName;
      if (arm.variant.typeName !== typeName) {
        errors.push(`когда: смешаны перечни ${typeName} и ${arm.variant.typeName}`);
      }
      const key = `${arm.variant.typeName}.${arm.variant.variant}`;
      if (seen.has(key)) errors.push(`когда: повтор ветки ${key}`);
      seen.add(key);
    }
    if (!typeName) return;
    const td = typeByName.get(typeName);
    if (!td?.variants || td.variants.length === 0) return;
    if (stmt.elseBody !== undefined) {
      return;
    }
    const missing = td.variants.filter((v) => !seen.has(`${typeName}.${v}`));
    if (missing.length > 0) {
      errors.push(`когда: не разобраны варианты ${missing.map((v) => `${typeName}.${v}`).join(", ")}`);
    }
  }

  // Первый проход: литералы пусть мир: Мир = {…} (как раньше).
  function visitStmtsLiteralPass(stmts: Stmt[]): void {
    for (let i = 0; i < stmts.length; i++) {
      const s = stmts[i]!;
      if (s.kind === "когда") {
        checkKogda(s);
        for (const arm of s.arms) visitStmtsLiteralPass(arm.body);
        if (s.elseBody) visitStmtsLiteralPass(s.elseBody);
        if (s.arms.length > 0) stmts[i] = desugarKogda(s);
        continue;
      }
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

  for (const proc of ast.procedures) {
    visitStmtsLiteralPass(proc.body);
  }

  // ── РАЗВОРОТ ФОРМЫ `arr[i]` ПО ТИПУ ОПЕРАНДА — ПЕРВЫЙ ПРОХОД, ДО ВСЕХ ОСТАЛЬНЫХ ──────────────
  //
  // Строка → `система.строка.символ`, всё прочее → прежний массивный доступ. И это обязано быть
  // РАНЬШЕ ПРОВЕРКИ ТИПОВ, а не «где-то рядом»: тип возврата у массивного доступа НАМЕРЕННО
  // неизвестен (элемент списка выводится по контейнеру — отдельная работа), у символьного — Строка.
  // Каждый, кто читает тип (`inferExprType`), обязан видеть уже развёрнутую форму.
  //
  // ЗАМЕР, которым это найдено (`src/self-host/lexer.osnova`, проба `.tmp/osnova-ast-probe.ts`):
  // `пусть два = с[0] + с[1]` выводилось как **Число**, и законная передача в параметр `Строка`
  // отвергалась: «Несовпадение типа (принять#0): ожидалось Строка, получено Число». Причина НЕ в `+`
  // (он склеивает, если хоть один операнд — строка, и это верно) и не в выводе типов: к моменту
  // проверки на месте `с[0]` стоял ещё массивный доступ с неизвестным типом, поэтому `+` уходил в
  // числовую ветвь. Прежний порядок делал лексер на v3 НЕПИШУЩИМСЯ: склейка двух символов — самая
  // частая его операция.
  for (const proc of ast.procedures) {
    const env: Env = new Map();
    for (let i = 0; i < proc.params.length; i++) {
      const pt = proc.paramTypes?.[i];
      if (pt) env.set(proc.params[i]!, pt);
    }
    resolveStringIndexInStmts(proc.body, env);
  }

  const procByName = new Map(ast.procedures.map((p) => [p.name, p]));
  for (const proc of ast.procedures) {
    const env: Env = new Map();
    for (let i = 0; i < proc.params.length; i++) {
      const pt = proc.paramTypes?.[i];
      if (pt) env.set(proc.params[i]!, pt);
    }
    checkStmtsTyped(proc.body, env, procByName);
  }

  // ─── проверка `вернуть` против объявленного/выведенного типа возврата ───
  function checkReturns(stmts: Stmt[], env: Env, expected: TypeRef): void {
    for (const s of stmts) {
      switch (s.kind) {
        case "вернуть":
          // `вернуть` без значения — ранний выход (возврат пусто), совместим с gradual.
          if (s.value) checkExprAgainst(expected, s.value, env, "вернуть");
          break;
        case "пусть": {
          if (s.typeAnnotation) env.set(s.name, s.typeAnnotation);
          else {
            const t = inferExprType(s.init, env);
            if (t) env.set(s.name, t);
          }
          break;
        }
        case "если":
          checkReturns(s.body, new Map(env), expected);
          if (s.elseIfClauses) for (const c of s.elseIfClauses) checkReturns(c.body, new Map(env), expected);
          if (s.elseBody) checkReturns(s.elseBody, new Map(env), expected);
          break;
        case "пока":
        case "цикл":
          checkReturns(s.body, new Map(env), expected);
          break;
        case "для_каждого": {
          const srcT = inferExprType(s.source, env);
          const bodyEnv = new Map(env);
          if (srcT?.array) bodyEnv.set(s.item, { name: srcT.name, nullable: srcT.nullable });
          if (s.index) bodyEnv.set(s.index, { name: "Число", nullable: false });
          checkReturns(s.body, bodyEnv, expected);
          break;
        }
        case "попробовать":
          checkReturns(s.body, new Map(env), expected);
          checkReturns(s.catchBody, new Map(env), expected);
          break;
        default:
          break;
      }
    }
  }

  for (const proc of ast.procedures) {
    const expected = returnTypeByProc.get(proc.name);
    if (!expected) continue;
    const env: Env = new Map();
    for (let i = 0; i < proc.params.length; i++) {
      const pt = proc.paramTypes?.[i];
      if (pt) env.set(proc.params[i]!, pt);
    }
    checkReturns(proc.body, env, expected);
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

  /**
   * `длина` — НЕЙТРАЛЬНОЕ имя: один узел, а реализацию выбирает СЕМАНТИКА по типу
   * операнда. `длина "абв"` → `система.строка.длина`, `длина [1,2]` →
   * `система.массив.длина`.
   *
   * Зачем так, а не «в лексере сразу в массивную». В языке две длины, и различить
   * их СИНТАКСИЧЕСКИ нельзя: `длина х` одинакова для строки и списка. Решать это
   * должен слой, который ЗНАЕТ тип, — иначе строковая длина недостижима, а это
   * блокер для прикладных программ (строки там везде: имена, описания).
   *
   * Если тип не выведен — остаётся массивная длина: это прежнее поведение, и
   * молчаливая смена реализации была бы хуже явного `undefined`.
   */
  function resolveLength(expr: Expr, env: Env): void {
    switch (expr.kind) {
      case "вызов": {
        if (expr.name === "длина" && expr.args.length === 1) {
          const t = inferExprType(expr.args[0]!, env);
          if (t?.name === "Строка") {
            expr.name = "система.строка.длина";
          } else if (t?.array === true) {
            expr.name = "система.массив.длина";
          } else if (t !== undefined) {
            // ТИП ИЗВЕСТЕН, НО ЭТО НЕ СТРОКА И НЕ СПИСОК (TD-0006). Прежде эта ветвь была общей с
            // «тип не выведен» и советовала добавить аннотацию — даже там, где аннотация УЖЕ СТОИТ
            // (`пусть ч: Число = 5` + `длина ч`: замер — читатель шёл добавлять то, что есть, а
            // НАСТОЯЩЕЙ причины не видел). Причина здесь в ТИПЕ, и она называется.
            const арг = expr.args[0]!;
            errors.push(
              "«длина» определена для Строки и Списка, а у " +
                (арг.kind === "переменная" ? `«${арг.name}»` : "выражения") +
                ` тип «${t.name}» — длины для него нет`,
            );
          } else {
            // ТИП НЕ ВЫВЕДЕН — ОТКАЗ, а не догадка. Прежде здесь молча выбиралась
            // массивная длина: на строке это вернуло бы неверное число, то есть
            // ровно ту тихую ложь, из-за которой в проекте уже разбирали `arr[i]` с
            // несуществующим полем. Названный отказ лучше верного на вид числа.
            const арг = expr.args[0]!;
            errors.push(
              "«длина» требует известного типа операнда: у " +
                (арг.kind === "переменная" ? `«${арг.name}»` : "выражения") +
                " тип не выведен — добавьте аннотацию (например «пусть имена: Список Строка = …»): " +
                "без типа неясно, нужна длина строки или длина списка",
            );
          }
        }
        for (const a of expr.args) resolveLength(a, env);
        return;
      }
      case "бинарное":
        resolveLength(expr.left, env);
        resolveLength(expr.right, env);
        return;
      case "унарное":
        resolveLength(expr.arg, env);
        return;
      case "поле":
        resolveLength(expr.object, env);
        return;
      case "массив":
        for (const э of expr.elements) resolveLength(э, env);
        return;
      case "объект":
        for (const п of expr.entries) resolveLength(п.value, env);
        return;
      case "кортеж":
        for (const э of expr.элементы) resolveLength(э, env);
        return;
      default:
        return;
    }
  }

  /**
   * `с[i]` — РАЗВОРОТ ПО ТИПУ ОПЕРАНДА, ровно как у `длина`.
   *
   * Парсер ставит форму `система.массив.получить(база, индекс)` — и это ПРАВИЛЬНО: `arr[i]` есть
   * форма ОБРАЩЕНИЯ, одна для списка и для строки, а не сахар над массивной операцией. Различить
   * их СИНТАКСИЧЕСКИ нечем: `с[0]` одинаково выглядит для строки и для списка. Значит решать
   * обязан слой, который ЗНАЕТ тип, — то есть этот.
   *
   * Что было: у строки `система.массив.получить` возвращала **`null`**, и `"абв"[0] + 100` давало
   * **100** — символ вёл себя как ноль. Для лексера это худший исход: буквы «читались» бы как нули,
   * и поток токенов вышел бы пустым МОЛЧА (тихая ложь, а не отказ).
   *
   * Чего здесь НЕТ: отказа при невыведенном типе. У `длина` он есть, потому что там два РАЗНЫХ
   * числа (длина строки и длина списка) и выбор молча дал бы неверное. Здесь выбор другой: строка →
   * символ, всё остальное → прежняя массивная операция. Невыведенный тип означает «не строка», и
   * это ровно прежнее поведение, а не догадка о новом.
   */
  function resolveStringIndex(expr: Expr, env: Env): void {
    switch (expr.kind) {
      case "вызов": {
        if (expr.name === "система.массив.получить" && expr.args.length === 2) {
          const t = inferExprType(expr.args[0]!, env);
          if (t?.name === "Строка" && t.array !== true) {
            expr.name = "система.строка.символ";
          }
        }
        for (const a of expr.args) resolveStringIndex(a, env);
        return;
      }
      case "бинарное":
        resolveStringIndex(expr.left, env);
        resolveStringIndex(expr.right, env);
        return;
      case "унарное":
        resolveStringIndex(expr.arg, env);
        return;
      case "поле":
        resolveStringIndex(expr.object, env);
        return;
      case "массив":
        for (const э of expr.elements) resolveStringIndex(э, env);
        return;
      case "объект":
        for (const п of expr.entries) resolveStringIndex(п.value, env);
        return;
      case "кортеж":
        for (const э of expr.элементы) resolveStringIndex(э, env);
        return;
      default:
        return;
    }
  }

  function resolveStringIndexInStmts(stmts: Stmt[], env: Env): void {
    for (const s of stmts) {
      switch (s.kind) {
        case "пусть":
          resolveStringIndex(s.init, env);
          if (s.typeAnnotation) env.set(s.name, s.typeAnnotation);
          else {
            const t = inferExprType(s.init, env);
            if (t) env.set(s.name, t);
          }
          break;
        case "присвоить":
          resolveStringIndex(s.value, env);
          break;
        case "поле_присвоить":
          resolveStringIndex(s.object, env);
          resolveStringIndex(s.value, env);
          break;
        case "выражение":
          resolveStringIndex(s.expr, env);
          break;
        case "вернуть":
          if (s.value) resolveStringIndex(s.value, env);
          break;
        case "выбросить":
          resolveStringIndex(s.value, env);
          break;
        case "если":
          resolveStringIndex(s.condition, env);
          resolveStringIndexInStmts(s.body, new Map(env));
          if (s.elseIfClauses) for (const c of s.elseIfClauses) {
            resolveStringIndex(c.condition, env);
            resolveStringIndexInStmts(c.body, new Map(env));
          }
          if (s.elseBody) resolveStringIndexInStmts(s.elseBody, new Map(env));
          break;
        case "пока":
          resolveStringIndex(s.condition, env);
          resolveStringIndexInStmts(s.body, new Map(env));
          break;
        case "для_каждого":
          resolveStringIndex(s.source, env);
          resolveStringIndexInStmts(s.body, new Map(env));
          break;
        case "цикл":
          resolveStringIndexInStmts(s.body, new Map(env));
          break;
        case "когда":
          resolveStringIndex(s.scrutinee, env);
          for (const arm of s.arms) {
            resolveStringIndex(arm.variant, env);
            resolveStringIndexInStmts(arm.body, new Map(env));
          }
          if (s.elseBody) resolveStringIndexInStmts(s.elseBody, new Map(env));
          break;
        case "попробовать":
          resolveStringIndexInStmts(s.body, new Map(env));
          resolveStringIndexInStmts(s.catchBody, new Map(env));
          break;
        case "распаковать":
          resolveStringIndex(s.значение, env);
          break;
        default:
          break;
      }
    }
  }

  function resolveLengthInStmts(stmts: Stmt[], env: Env): void {
    for (const s of stmts) {
      switch (s.kind) {
        case "пусть":
          resolveLength(s.init, env);
          if (s.typeAnnotation) env.set(s.name, s.typeAnnotation);
          else {
            const t = inferExprType(s.init, env);
            if (t) env.set(s.name, t);
          }
          break;
        case "присвоить":
          resolveLength(s.value, env);
          break;
        case "поле_присвоить":
          resolveLength(s.object, env);
          resolveLength(s.value, env);
          break;
        case "выражение":
          resolveLength(s.expr, env);
          break;
        case "вернуть":
          if (s.value) resolveLength(s.value, env);
          break;
        case "выбросить":
          resolveLength(s.value, env);
          break;
        case "если":
          resolveLength(s.condition, env);
          resolveLengthInStmts(s.body, new Map(env));
          if (s.elseIfClauses) for (const c of s.elseIfClauses) {
            resolveLength(c.condition, env);
            resolveLengthInStmts(c.body, new Map(env));
          }
          if (s.elseBody) resolveLengthInStmts(s.elseBody, new Map(env));
          break;
        case "пока":
          resolveLength(s.condition, env);
          resolveLengthInStmts(s.body, new Map(env));
          break;
        case "цикл":
          resolveLengthInStmts(s.body, new Map(env));
          break;
        case "для_каждого":
          resolveLength(s.source, env);
          resolveLengthInStmts(s.body, new Map(env));
          break;
        case "когда":
          resolveLength(s.scrutinee, env);
          for (const arm of s.arms) {
            resolveLength(arm.variant, env);
            resolveLengthInStmts(arm.body, new Map(env));
          }
          if (s.elseBody) resolveLengthInStmts(s.elseBody, new Map(env));
          break;
        case "попробовать":
          resolveLengthInStmts(s.body, new Map(env));
          resolveLengthInStmts(s.catchBody, new Map(env));
          break;
        case "распаковать":
          resolveLength(s.значение, env);
          break;
        default:
          break;
      }
    }
  }

  // Разворот `arr[i]` по типу операнда УЖЕ сделан — первым проходом, до проверки типов (см. выше,
  // рядом с `visitStmtsLiteralPass`). Здесь остаётся вывод длин: он ЧИТАЕТ имена, которые первый
  // проход дописал, и потому обязан идти после него. Прежний порядок («разворот здесь, вместе с
  // длинами») отвергал законную программу `пусть знак = с[1]` + `длина знак` с «тип не выведен».
  for (const proc of ast.procedures) {
    const env: Env = new Map();
    for (let i = 0; i < proc.params.length; i++) {
      const pt = proc.paramTypes?.[i];
      if (pt) env.set(proc.params[i]!, pt);
    }
    resolveLengthInStmts(proc.body, env);
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

  // ФРОНТЕНД: по умолчанию v2 (лексер + парсер), но он может быть ПОДСТАВЛЕН
  // снаружи (см. `CompileOptions.parse`). Компилятор о синтаксисе исходника не
  // знает: на выходе в обоих случаях — `Program` формы v2, и дальше путь один.
  let program: Program | null;
  let parserErrors: ParseError[];
  let lexerErrors: LexerError[];
  let warnings: ParseWarning[] = [];
  if (options.parse) {
    const подставлено = options.parse(source, options.filename ?? "вход");
    program = подставлено.ast;
    // Сообщения фронтенда приходят строкой «файл:строка: текст» — раскладываем их
    // на те же поля, что у v2-парсера, чтобы диагностика осталась единой.
    parserErrors = подставлено.errors.map((сообщение) => {
      const м = /^(.*?):(\d+):\s*(.*)$/.exec(сообщение);
      // Без разобранной позиции строка всё равно нужна полем: диагностика ждёт
      // `line` числом, поэтому называем первую строку, а не «неизвестно».
      return м
        ? { message: м[3]!, line: Number(м[2]), column: 1 }
        : { message: сообщение, line: 1, column: 1 };
    });
    lexerErrors = [];
  } else {
    const лекс = tokenize(source);
    lexerErrors = лекс.errors;
    const разбор = parse(лекс.tokens, {
      warnDeprecated: options.warnDeprecated === true,
      // Файл = модуль (БЛОК 3, пункт 1): когда шапки `модуль имя` нет, имя модуля
      // берётся из имени файла — без него разбор назвал бы модуль «вход».
      filename: options.filename,
    });
    program = разбор.ast;
    parserErrors = разбор.errors;
    warnings = разбор.warnings;
  }

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
      warnings,
      durationMs: Date.now() - start,
      logs,
    };
  }

  const baseDir = options.baseDir ?? process.cwd();
  const entryFile = options.filename ?? "вход";

  let expandedAst: Module;
  try {
    const ast = getFirstModuleOrThrow(program);
    expandedAst = expandModuleImports(ast, baseDir, [], baseDir, entryFile);
  } catch (e) {
    const err = compilerErrorFromCaught(e);
    addLog(logs, 'error', 'codegen', err.message, start, toCompileError(err, err.line, err.column, 'import_error'));
    return {
      module: null,
      modules: [],
      compilerSuccess: false,
      lexerErrors: [],
      parserErrors: [],
      compilerErrors: [err],
      semanticErrors: [],
      warnings,
      durationMs: Date.now() - start,
      logs,
    };
  }

  let namedTypeErrors: { message: string; file?: string; line?: number; column?: number }[];
  if (program.modules.length === 1) {
    namedTypeErrors = validateNamedTypesAndRewrite(expandedAst).map((message) => ({ message }));
  } else {
    namedTypeErrors = [];
    for (const mod of program.modules) {
      try {
        const ex = expandModuleImports(mod, baseDir, [], baseDir, entryFile);
        namedTypeErrors.push(...validateNamedTypesAndRewrite(ex).map((message) => ({ message })));
      } catch (e) {
        namedTypeErrors.push(compilerErrorFromCaught(e));
      }
    }
  }
  if (namedTypeErrors.length > 0) {
    for (const err of namedTypeErrors) {
      addLog(logs, 'error', 'codegen', err.message, start, toCompileError(err, err.line, err.column, 'type_error'));
    }
    return {
      module: null,
      modules: [],
      moduleAst: expandedAst,
      compilerSuccess: false,
      lexerErrors: [],
      parserErrors: [],
      compilerErrors: namedTypeErrors,
      semanticErrors: [],
      warnings,
      durationMs: Date.now() - start,
      logs,
    };
  }

  const semanticErrors = analyzeProgram(
    { modules: [expandedAst] },
    { extraSyscalls: options.extraSyscalls, filename: entryFile },
  ).errors;
  const semanticAsCompiler = semanticErrors.map((e) => ({ message: `[semantic] ${e.message}` }));

  // Логирование семантических ошибок
  for (const err of semanticErrors) {
    addLog(logs, 'warn', 'semantic', err.message, start, toCompileError({ message: err.message, file: err.file }, err.line, undefined, err.kind));
  }

  if (program.modules.length > 1) {
    const programSemanticErrors = analyzeProgram(program, {
      extraSyscalls: options.extraSyscalls,
      filename: entryFile,
    }).errors;
    const programSemanticAsCompiler = programSemanticErrors.map((e) => ({ message: `[semantic] ${e.message}` }));
    try {
      const compiledModules = compileProgram(program).map(optimizeIrModule);
      return {
        module: compiledModules[0] ?? null,
        modules: compiledModules,
        moduleAst: getFirstModuleOrThrow(program),
        compilerSuccess: true,
        lexerErrors: [],
        parserErrors: [],
        compilerErrors: programSemanticAsCompiler,
        semanticErrors: programSemanticErrors,
        warnings,
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
        warnings,
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
      moduleAst: expandedAst,
      compilerSuccess: true,
      lexerErrors: [],
      parserErrors: [],
      compilerErrors: semanticAsCompiler,
      semanticErrors,
      warnings,
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
      warnings,
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
function formatErrorLoc(e: { message: string; file?: string; line?: number; column?: number }): string {
  if (!e.file) return e.message;
  const loc =
    e.line != null
      ? `${e.file}:${e.line}${e.column != null ? `:${e.column}` : ""}`
      : e.file;
  return `${loc} ${e.message}`;
}

export function formatCompileFailureMessage(result: CompileResult): string {
  const report = compileToBuildReport(result);
  if (report.success) return '';
  const parts: string[] = [
    ...result.lexerErrors.map((e) => e.message),
    ...result.parserErrors.map((e) => e.message),
    ...result.compilerErrors.map(formatErrorLoc),
    ...result.semanticErrors.map((e) => e.message),
  ];
  return parts.length > 0 ? parts.join('; ') : 'compilation failed';
}
