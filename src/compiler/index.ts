/**
 * Публичный вход зоны compiler: compile API и стадии пайплайна.
 * Порядок контракта: lexer → parser → semantic → codegen (`compile` / `compileProgram`);
 * сквозная сборка — `compileSource`, `Compiler`, `compileToBuildReport`; VM — `./vm`.
 * Re-export подмодулей не пересекается по именам.
 */
export * from "./compiler";
export * from "./codegen";
export * from "./vm";
export * from "./lexer";
export * from "./parser";
export * from "./semantic";
