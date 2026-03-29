/**
 * Публичная точка входа рантайма VM / интерпретатора.
 * Из `./vm` — OsVbcVM и пайплайн; из `./interpreter` — runProgram, loadModule, Interpreter, VM (то же исполнение, что под капотом у `vm.ts`).
 * Импорт из `../runtime`, `./vm` или `./interpreter` даёт согласованную поверхность.
 */
export * from "./vm";
export { Interpreter, InterpreterError, runProgram, loadModule, VM } from "./interpreter";
export type { RunProgramOptions, TryFrame } from "./interpreter";
