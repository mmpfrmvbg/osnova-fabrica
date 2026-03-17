/**
 * Компилятор Основа MVP: .osnova → OsVbcModule (JSON .osvbc).
 * Пайплайн: tokenize → parse → compile → JSON.
 */

import { tokenize } from "./lexer";
import { parse, type ParseError } from "./parser";
import { compile } from "./codegen";
import type { OsVbcModule } from "../osnova-runtime/vm/bytecode";

export interface CompileResult {
  module: OsVbcModule | null;
  lexErrors: { message: string; line: number; column: number }[];
  parseErrors: ParseError[];
}

export function compileSource(source: string): CompileResult {
  const { tokens, errors: lexErrors } = tokenize(source);
  const { ast, errors: parseErrors } = parse(tokens);
  if (lexErrors.length > 0 || parseErrors.length > 0 || !ast) {
    return { module: null, lexErrors, parseErrors };
  }
  try {
    const module = compile(ast);
    return { module, lexErrors, parseErrors };
  } catch (e) {
    parseErrors.push({
      message: e instanceof Error ? e.message : String(e),
      line: 0,
      column: 0,
    });
    return { module: null, lexErrors, parseErrors };
  }
}
