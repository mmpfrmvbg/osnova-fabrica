/**
 * Точка входа «VM компилятора»: байткод-машина для скомпилированных модулей Основы.
 * Реализация в runtime; здесь — стабильный re-export для тестов и инструментов в зоне compiler.
 */
export { VM, InterpreterError, runProgram, loadModule } from "../runtime/vm/interpreter";
export type { StackValue, InvokeHandler, InterpreterOptions, RunProgramOptions } from "../runtime/vm/interpreter";
export type { OsVbcModule } from "../runtime/vm/bytecode";
