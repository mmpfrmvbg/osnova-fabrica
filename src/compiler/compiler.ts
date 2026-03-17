/**
 * Компилятор Основа MVP: .osnova → OsVbcModule (JSON .osvbc).
 * Пайплайн: tokenize → parse → compile → JSON.
 *
 * Поля CompileResult выровнены под BuildReport (pipeline/types.ts):
 *   lexerErrors / parserErrors / compilerErrors / compilerSuccess / module / durationMs
 */

import { tokenize } from './lexer';
import { parse, type ParseError } from './parser';
import { compile } from './codegen';
import type { OsVbcModule } from '../runtime/vm/bytecode';

export interface CompileResult {
  /** Скомпилированный модуль — null если есть ошибки */
  module: OsVbcModule | null;
  /** true если компилятор отработал без ошибок */
  compilerSuccess: boolean;
  /** Ошибки лексера */
  lexerErrors: { message: string; line: number; column: number }[];
  /** Ошибки парсера */
  parserErrors: ParseError[];
  /** Ошибки компилятора (codegen-фаза) */
  compilerErrors: { message: string; node?: string }[];
  /** Время компиляции в мс */
  durationMs: number;
}

export function compileSource(source: string): CompileResult {
  const start = Date.now();
  const { tokens, errors: lexerErrors } = tokenize(source);
  const { ast, errors: parserErrors } = parse(tokens);

  if (lexerErrors.length > 0 || parserErrors.length > 0 || !ast) {
    return {
      module: null,
      compilerSuccess: false,
      lexerErrors,
      parserErrors,
      compilerErrors: [],
      durationMs: Date.now() - start,
    };
  }

  try {
    const module = compile(ast);
    return {
      module,
      compilerSuccess: true,
      lexerErrors: [],
      parserErrors: [],
      compilerErrors: [],
      durationMs: Date.now() - start,
    };
  } catch (e) {
    return {
      module: null,
      compilerSuccess: false,
      lexerErrors: [],
      parserErrors: [],
      compilerErrors: [{ message: e instanceof Error ? e.message : String(e) }],
      durationMs: Date.now() - start,
    };
  }
}
