/**
 * Публичная точка входа рантайма VM / интерпретатора.
 * Агенты и пайплайн могут импортировать из `../runtime` или из `./vm` / `./interpreter` — поверхность совпадает.
 */
export * from "./vm";
export { Interpreter, InterpreterError, runProgram, loadModule, VM } from "./interpreter";
export type { RunProgramOptions, TryFrame } from "./interpreter";
