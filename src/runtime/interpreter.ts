/**
 * Публичный фасад VM: класс Interpreter и имена опкодов для стековых операций.
 * Реализация шага — в ./vm/interpreter (VM).
 */

import { VM } from "./vm/interpreter";
import type { InterpreterOptions, StackValue } from "./vm/interpreter";

export type { InterpreterOptions, StackValue, InvokeHandler, RunProgramOptions } from "./vm/interpreter";
export {
  InterpreterError,
  runProgram,
  loadModule,
  VM,
} from "./vm/interpreter";

/** Имена базовых стековых инструкций (соответствуют полю `op` в байткоде). */
export enum OpCode {
  /** Константа из пула: инструкция `const` с индексом `k`. */
  PUSH = "const",
  /** Снять вершину стека. */
  POP = "pop",
  /** Дублировать вершину стека. */
  DUP = "dup",
}

export class Interpreter extends VM {
  /** Стек исполнения (верх — последний элемент). */
  get executionStack(): readonly StackValue[] {
    return this.debugStack;
  }

  constructor(
    module: ConstructorParameters<typeof VM>[0],
    options: InterpreterOptions = {},
  ) {
    super(module, options);
  }
}
