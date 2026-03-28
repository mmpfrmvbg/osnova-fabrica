/**
 * Публичный фасад VM: класс Interpreter и имена опкодов для стековых операций.
 * Реализация шага — в ./vm/interpreter (VM).
 */

import { VM } from "./vm/interpreter";
import type { InterpreterOptions, StackValue, TryFrame } from "./vm/interpreter";
import type { RawInstruction } from "./vm/bytecode";

export type { InterpreterOptions, StackValue, InvokeHandler, RunProgramOptions, TryFrame } from "./vm/interpreter";
export {
  InterpreterError,
  runProgram,
  loadModule,
  VM,
} from "./vm/interpreter";

/** Имена стековых и управляющих инструкций (соответствуют полю `op` в байткоде). */
export enum OpCode {
  /** Константа из пула: инструкция `const` с индексом `k`. */
  PUSH = "const",
  /** Снять вершину стека. */
  POP = "pop",
  /** Дублировать вершину стека. */
  DUP = "dup",
  /** Сложение: снимает b, затем a; кладёт a + b. */
  ADD = "add",
  /** Вычитание: кладёт a − b. */
  SUB = "sub",
  /** Умножение: кладёт a × b. */
  MUL = "mul",
  /** Деление: кладёт a / b; деление на ноль — InterpreterError. */
  DIV = "div",
  /** Равенство: снимает b, затем a; кладёт (a === b). */
  EQ = "eq",
  /** Меньше: кладёт (a < b) для чисел. */
  LT = "lt",
  /** Больше: кладёт (a > b) для чисел. */
  GT = "gt",
  /** Логическое И: кладёт Boolean(a && b). */
  AND = "and",
  /** Логическое ИЛИ: кладёт Boolean(a || b). */
  OR = "or",
  /** Логическое НЕ: снимает одно значение; кладёт !v. */
  NOT = "not",
  /** Безусловный переход: `off` — абсолютный индекс следующей инструкции в `code`. */
  JUMP = "jmp",
  /** Условный переход: снимает условие со стека; при falsy переход на `off`, иначе следующая инструкция. */
  JUMP_IF_FALSE = "jmp_if_not",
  /** Вызов процедуры по индексу `fi` в таблице процедур; новый фрейм локалей, возврат после `ret`. */
  CALL = "call",
  /** Возврат из текущей процедуры (значение на вершине стека — результат, если есть). */
  RETURN = "ret",
  /** Выбросить значение с вершины стека как исключение; при наличии try — переход в catch. */
  THROW = "throw",
  /** Регистрация обработчика (байткод `try_begin`): `off` — абсолютный PC входа в catch. */
  TRY_CATCH = "try_begin",
  /** Снятие обработчика после успешного прохода try (`try_end`). Отдельного опкода finally в v0.1 нет. */
  FINALLY = "try_end",
}

export class Interpreter extends VM {
  /** Стек исполнения (верх — последний элемент). */
  get executionStack(): readonly StackValue[] {
    return this.debugStack;
  }

  /** Активные try-обработчики (для отладки; соответствует внутреннему стеку `try_begin`). */
  get exceptionHandlers(): readonly TryFrame[] {
    return this.activeExceptionHandlers;
  }

  constructor(
    module: ConstructorParameters<typeof VM>[0],
    options: InterpreterOptions = {},
  ) {
    super(module, options);
  }

  /**
   * Пошаговое исполнение: одна инструкция байткода.
   * Возвращает следующий PC, абсолютный переход или `"ret"` — как внутри {@link VM.runProcedure}.
   */
  interpret(ins: RawInstruction): Promise<number | "ret"> {
    return this.interpretInstruction(ins);
  }
}
