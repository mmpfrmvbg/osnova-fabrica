/**
 * Точка входа «VM компилятора»: байткод-машина для скомпилированных модулей Основы.
 * Оператор исходника `%` компилируется в инструкцию `rem` (см. codegen); выполнение —
 * в `src/runtime/vm/interpreter.ts` (case "rem", семантика как у JavaScript `%`).
 * Здесь — стабильный re-export для тестов и инструментов в зоне compiler.
 */
export { VM, InterpreterError, runProgram, loadModule } from "../runtime/vm/interpreter";
export type { StackValue, InvokeHandler, InterpreterOptions, RunProgramOptions } from "../runtime/vm/interpreter";
export type { OsVbcModule } from "../runtime/vm/bytecode";
