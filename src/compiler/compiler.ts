/**
 * Компилятор Основа MVP: .osnova → OsVbcModule (JSON .osvbc).
 * Пайплайн: tokenize → parse → compile → JSON.
 *
 * Поля CompileResult выровнены под BuildReport (pipeline/types.ts):
 *   lexerErrors / parserErrors / compilerErrors / compilerSuccess / module / durationMs
 */

import { tokenize } from './lexer';
import { parse, type ParseError } from './parser';
import { compile, compileProgram } from './codegen';
import type { OsVbcModule } from '../runtime/vm/bytecode';
import { analyzeProgram, type SemanticError } from './semantic';
import type { Expr, Program, Module, Procedure, Stmt, TypeDeclaration, TypeRef } from './ast';
import * as fs from 'fs';
import * as path from 'path';

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

const PRIMITIVE_FIELD_TYPES = new Set(["Целое32", "Строка", "Логический"]);

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

  let expandedAst: Module;
  try {
    const ast = getFirstModuleOrThrow(program);
    expandedAst = expandModuleImports(ast, options.baseDir ?? process.cwd());
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

  const namedTypeErrors = validateNamedTypesAndRewrite(expandedAst);
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
      const compiledModules = compileProgram(program);
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
    const module = compile(expandedAst);
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
