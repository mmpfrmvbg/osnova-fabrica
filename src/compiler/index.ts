/**
 * Публичный вход зоны compiler: compile API и стадии пайплайна.
 * Порядок контракта: lexer → parser → semantic → codegen (`compile` / `compileProgram`);
 * сквозная сборка — `compileSource`, `Compiler`, `compileToBuildReport`; VM — `./vm`.
 * Self-fix / агенты: тот же контракт, что у внутреннего `./compiler` — `formatCompileFailureMessage`,
 * `compileToBuildReport` и `Compiler.execute` доступны из реэкспорта `./compiler`.
 * Синтаксический слой (lex/parse) реэкспортируется явно из `./lexer` и `./parser` — без смешивания с семантикой;
 * далее — semantic, codegen, фасад `./compiler`, VM.
 * Re-export подмодулей не пересекается по именам; порядок export — как у фаз, затем фасад, затем VM.
 */
export type { TokenKind, Token, LexerError, LexerResult } from "./lexer";
export { ALL_TOKEN_KINDS, KEYWORDS, tokenize } from "./lexer";
export type { ParseErrorContext, ParseError, ParseResult } from "./parser";
export { parse, printParseError } from "./parser";
/** Семантика: только явные экспорты из `./semantic` (без `export *`). */
export type { SemanticError, SemanticResult } from "./semantic";
export { analyzeProgram, checkSemantics } from "./semantic";
export * from "./codegen";
export * from "./compiler";
export * from "./vm";

// Экспорт для обработки ошибок и логирования
export type { CompileError, CompileLog } from "./compiler";
