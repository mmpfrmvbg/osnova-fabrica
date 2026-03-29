/**
 * Публичный вход зоны compiler: compile API и стадии пайплайна.
 * Порядок контракта: lexer → parser → semantic → codegen (`compile` / `compileProgram`);
 * сквозная сборка — `compileSource`, `Compiler`, `compileToBuildReport`; VM — `./vm`.
 * Re-export подмодулей не пересекается по именам; порядок export — как у фаз, затем фасад, затем VM.
 */
export * from "./lexer";
export * from "./parser";
export * from "./semantic";
export * from "./codegen";
export * from "./compiler";
export * from "./vm";
