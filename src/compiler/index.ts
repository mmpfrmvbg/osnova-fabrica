/**
 * Публичный вход зоны compiler: compile API и стадии пайплайна.
 * Порядок контракта: lexer → parser → semantic → codegen (`compile` / `compileProgram`);
 * сквозная сборка — `compileSource`, `Compiler`, `compileToBuildReport`; VM — `./vm`.
 * Self-fix / агенты: тот же контракт, что у внутреннего `./compiler` — `formatCompileFailureMessage`,
 * `compileToBuildReport` и `Compiler.execute` доступны из реэкспорта `./compiler`.
 * Связка токенизации/разбора: первые два `export *` — `./lexer` (`tokenize`) и `./parser` (`parse`), до semantic и codegen.
 * Re-export подмодулей не пересекается по именам; порядок export — как у фаз, затем фасад, затем VM.
 */
export * from "./lexer";
export * from "./parser";
export * from "./semantic";
export * from "./codegen";
export * from "./compiler";
export * from "./vm";

// Экспорт для обработки ошибок и логирования
export type { CompileError, CompileLog } from "./compiler";
