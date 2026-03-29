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
import { analyzeProgram, type SemanticError } from './semantic';
import { BLOCKING_SEMANTIC_KINDS } from './semanticKinds';
import type { Expr, Program, Module, Procedure, Stmt, TypeDeclaration } from './ast';
import * as fs from 'fs';
import * as path from 'path';
import type { BuildReport } from '../pipeline/types';

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
}

export interface CompileOptions {
  /** Базовая директория для разрешения импортов `использовать ... из "путь"`. */
  baseDir?: string;
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
    const result = this.compile(source, { baseDir });
    if (!result.compilerSuccess || !result.module) {
      const parts = [
        ...result.lexerErrors.map((e) => e.message),
        ...result.parserErrors.map((e) => e.message),
        ...result.compilerErrors.map((e) => e.message),
      ];
      throw new Error(parts.length > 0 ? parts.join("; ") : "compilation failed");
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

function resolveImportPath(importPath: string, baseDir: string): string {
  if (path.isAbsolute(importPath)) return importPath;
  return path.join(baseDir, importPath);
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

function expandModuleImports(ast: Module, baseDir: string, importStack: string[] = []): Module {
  const aliasToExportedProcNameToPrefixed = new Map<string, Map<string, string>>();
  const mergedTypeDeclarations: TypeDeclaration[] = [...ast.typeDeclarations];

  const inlinedProcedures: Procedure[] = [];
  for (const imp of ast.imports) {
    const resolved = resolveImportPath(imp.path, baseDir);
    if (!fs.existsSync(resolved)) throw new Error(`Модуль не найден: ${imp.path}`);
    if (importStack.includes(resolved)) throw new Error(`Циклический импорт: ${imp.path}`);

    const importedSource = fs.readFileSync(resolved, "utf-8");
    const importedAst = parseModuleOrThrow(importedSource);
    const importedExpanded = expandModuleImports(importedAst, path.dirname(resolved), [...importStack, resolved]);

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

function validateNamedTypesAndRewrite(ast: Module): string[] {
  const errors: string[] = [];

  const typeByName = new Map<string, TypeDeclaration>();
  for (const td of ast.typeDeclarations) {
    if (!typeByName.has(td.name)) typeByName.set(td.name, td);
  }

  for (const td of ast.typeDeclarations) {
    for (const f of td.fields) {
      if (!PRIMITIVE_FIELD_TYPES.has(f.type.name)) {
        errors.push(`Неподдерживаемый тип поля: ${f.type.name}`);
      }
    }
  }

  function visitExprObjectLiteralRewrite(objExpr: Expr & { kind: "объект" }, typeName: string): void {
    const typeDef = typeByName.get(typeName);
    if (!typeDef) return;

    const fieldByName = new Map(typeDef.fields.map((f) => [f.name, f]));
    const entries = objExpr.entries;
    const entryIndexByKey = new Map<string, number>();
    for (let i = 0; i < entries.length; i++) entryIndexByKey.set(entries[i]!.key, i);

    // Неизвестные поля в литерале.
    for (const entry of entries) {
      if (!fieldByName.has(entry.key)) {
        errors.push(`Неизвестное поле: ${entry.key} (тип ${typeName})`);
      }
    }

    // Обязательные / nullable поля.
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

  function visitStmts(stmts: Stmt[]): void {
    for (const s of stmts) {
      switch (s.kind) {
        case "пусть": {
          if (!s.typeAnnotation) break;
          const typeName = s.typeAnnotation.name;
          const typeDef = typeByName.get(typeName);
          if (!typeDef) {
            errors.push(`Тип не объявлен: ${typeName}`);
            break;
          }

          if (s.init.kind === "объект") {
            visitExprObjectLiteralRewrite(s.init, typeName);
          }
          break;
        }
        case "если":
          visitStmts(s.body);
          if (s.elseIfClauses) for (const c of s.elseIfClauses) visitStmts(c.body);
          if (s.elseBody) visitStmts(s.elseBody);
          break;
        case "пока":
        case "цикл":
          visitStmts(s.body);
          break;
        case "для_каждого":
          visitStmts(s.body);
          break;
        case "попробовать":
          visitStmts(s.body);
          visitStmts(s.catchBody);
          break;
        case "присвоить":
        case "поле_присвоить":
        case "выражение":
        case "выбросить":
        case "вернуть":
          break;
      }
    }
  }

  visitStmts(ast.procedures.flatMap((p) => p.body));
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
  const { tokens, errors: lexerErrors } = tokenize(source);
  const { ast: program, errors: parserErrors } = parse(tokens);

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
    };
  }

  const baseDir = options.baseDir ?? process.cwd();

  let expandedAst: Module;
  try {
    const ast = getFirstModuleOrThrow(program);
    expandedAst = expandModuleImports(ast, baseDir);
  } catch (e) {
    return {
      module: null,
      modules: [],
      compilerSuccess: false,
      lexerErrors: [],
      parserErrors: [],
      compilerErrors: [{ message: e instanceof Error ? e.message : String(e) }],
      semanticErrors: [],
      durationMs: Date.now() - start,
    };
  }

  let namedTypeErrors: string[];
  if (program.modules.length === 1) {
    namedTypeErrors = validateNamedTypesAndRewrite(expandedAst);
  } else {
    namedTypeErrors = [];
    for (const mod of program.modules) {
      try {
        const ex = expandModuleImports(mod, baseDir);
        namedTypeErrors.push(...validateNamedTypesAndRewrite(ex));
      } catch (e) {
        namedTypeErrors.push(e instanceof Error ? e.message : String(e));
      }
    }
  }
  if (namedTypeErrors.length > 0) {
    return {
      module: null,
      modules: [],
      compilerSuccess: false,
      lexerErrors: [],
      parserErrors: [],
      compilerErrors: namedTypeErrors.map((message) => ({ message })),
      semanticErrors: [],
      durationMs: Date.now() - start,
    };
  }

  const semanticErrors = analyzeProgram({ modules: [expandedAst] }).errors;
  const semanticAsCompiler = semanticErrors.map((e) => ({ message: `[semantic] ${e.message}` }));

  if (program.modules.length > 1) {
    const programSemanticErrors = analyzeProgram(program).errors;
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
      };
    } catch (e) {
      return {
        module: null,
        modules: [],
        compilerSuccess: false,
        lexerErrors: [],
        parserErrors: [],
        compilerErrors: [
          ...programSemanticAsCompiler,
          { message: e instanceof Error ? e.message : String(e) },
        ],
        semanticErrors: programSemanticErrors,
        durationMs: Date.now() - start,
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
    };
  } catch (e) {
    return {
      module: null,
      modules: [],
      compilerSuccess: false,
      lexerErrors: [],
      parserErrors: [],
      compilerErrors: [
        ...semanticAsCompiler,
        { message: e instanceof Error ? e.message : String(e) },
      ],
      semanticErrors,
      durationMs: Date.now() - start,
    };
  }
}

/**
 * Адаптер: CompileResult (src/compiler/compiler.ts) → BuildReport (src/pipeline/types.ts).
 * Каноническая реализация — та же логика, что {@link import("../pipeline/orchestrator").compileToBuildReport}
 * (orchestrator реэкспортирует отсюда, чтобы не дублировать список blocking kinds).
 *
 * Разница:
 *   CompileResult.module      → BuildReport.bytecode
 *   + добавляет BuildReport.success = compilerSuccess && lexerErrors.length === 0
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
  };
}
