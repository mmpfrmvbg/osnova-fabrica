/**
 * v3-фронтенд: лексер и парсер языка Основа в написании v3.
 *
 * Контракт (`docs/compiler-v3-plan.md`): выдаётся AST ФОРМЫ v2
 * (`Program` из `src/compiler/ast.ts`), поэтому дальше идут общий кодоген,
 * общий рантайм, общий кодировщик e2k и общий планировщик. Второго рантайма,
 * второго кодогена и второй VM у v3 нет и быть не должно.
 */
export { tokenizeV3 } from "./lexer";
export type { V3LexResult, V3Token } from "./lexer";
export { parseV3 } from "./parser";
export type { V3Result } from "./parser";

import { parseV3, type V3Result } from "./parser";
import type { Module } from "../compiler/ast";

/** Разбор одного модуля: обёртка над {@link parseV3} для читающих вызовов. */
export function parseModule(source: string, filename?: string): { module?: Module; errors: string[] } {
  const р: V3Result = parseV3(source, filename);
  return { module: р.program?.modules[0], errors: р.errors };
}
