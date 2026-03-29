/**
 * Публичный вход зоны compiler: один контракт для компиляции (compile API), codegen и VM.
 */
export {
  Compiler,
  compileSource,
  compileToBuildReport,
  optimizeIrModule,
  type CompileResult,
  type CompileOptions,
  type ExecuteOptions,
  type OsnovaIrModule,
} from "./compiler";

export { compile, compileProgram } from "./codegen";

export { VM, InterpreterError, runProgram, loadModule } from "./vm";
export type {
  StackValue,
  InvokeHandler,
  InterpreterOptions,
  RunProgramOptions,
  OsVbcModule,
} from "./vm";
