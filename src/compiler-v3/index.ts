/**
 * Публичная точка v3-фронтенда: `parseV3(источник, имя файла?)`.
 *
 * Контракт (`docs/compiler-v3-plan.md`): выдаётся AST ФОРМЫ v2
 * (`Program` из `src/compiler/ast.ts`), поэтому дальше идут общий кодоген,
 * общий рантайм, общий кодировщик e2k и общий планировщик. Второго рантайма,
 * второго кодогена и второй VM у v3 нет и быть не должно.
 *
 * Исключений наружу нет: ошибки разбора (лексер + парсер) собираются в `errors`
 * в формате `файл:строка: текст`, и тогда `program` не определён.
 */

import type { Module } from "../compiler/ast";
import { DEFAULT_V3_FILENAME, tokenizeV3 } from "./lexer";
import { parseV3Tokens, type V3Result } from "./parser";

export { DEFAULT_V3_FILENAME, formatV3Error, tokenizeV3 } from "./lexer";
export type { V3LexResult, V3Token, V3TokenKind } from "./lexer";
export { DEFAULT_MODULE_NAME, moduleNameFromFilename, parseV3Tokens } from "./parser";
export type { V3Result } from "./parser";

/**
 * Разобрать исходник v3.
 *
 * @param source исходник на языке Основа в написании v3
 * @param filename имя файла: из него берётся имя модуля (файл = модуль) и оно же
 *   попадает в сообщения об ошибках. Без имени — `вход.osnova` (модуль «вход»).
 */
export function parseV3(source: string, filename: string = DEFAULT_V3_FILENAME): V3Result {
  const { tokens, errors } = tokenizeV3(source, filename);
  // Лексер отказал — поток токенов неполон: разбирать его значило бы выдать
  // каскад ошибок вместо одной настоящей.
  if (errors.length > 0) return { errors };
  return parseV3Tokens(tokens, filename);
}

/** Модуль одного файла: то же, что `parseV3(...).program.modules[0]`, но без обёртки. */
export function parseModule(source: string, filename?: string): { module?: Module; errors: string[] } {
  const р = parseV3(source, filename);
  return { module: р.program?.modules[0], errors: р.errors };
}
