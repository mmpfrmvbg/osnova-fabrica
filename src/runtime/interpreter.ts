/**
 * Публичный фасад VM: класс {@link Interpreter}, имена опкодов ({@link OpCode}) и пошаговый {@link interpret}.
 * Реализация шага (в т.ч. {@link OpCode.JUMP}, {@link OpCode.JUMP_IF_FALSE}, {@link OpCode.CALL}, {@link OpCode.RETURN}) — в ./vm/interpreter ({@link VM}).
 *
 * В пайплайне после intake {@link import("../agents/IntakeAgent").IntakeAgent} высокоуровневый запуск байткода
 * с глобалами спецификации делается через {@link import("./vm").OsVbcVM} и {@link import("./vm").OsVbcVM.execute};
 * этот класс — стековый движок внутри {@link import("./vm").OsVbcVM}.
 */

import { VM } from "./vm/interpreter";
import type { InterpreterOptions, StackValue, TryFrame } from "./vm/interpreter";
import type { Op, RawInstruction } from "./vm/bytecode";

export type { InterpreterOptions, StackValue, InvokeHandler, RunProgramOptions, TryFrame } from "./vm/interpreter";
export {
  InterpreterError,
  runProgram,
  loadModule,
  VM,
} from "./vm/interpreter";

/**
 * Имена стековых и управляющих инструкций (соответствуют полю `op` в байткоде).
 * Объект вместо `enum`, чтобы литералы совпадали с типом {@link Op} и {@link RawInstruction}.
 */
export const OpCode = {
  /** Константа из пула: инструкция `const` с индексом `k`. */
  PUSH: "const",
  /** Литерал true (не из пула констант). */
  CONST_TRUE: "const.true",
  /** Литерал false. */
  CONST_FALSE: "const.false",
  /** Литерал null. */
  CONST_NULL: "const.null",
  /** Снять вершину стека. */
  POP: "pop",
  /** Дублировать вершину стека. */
  DUP: "dup",
  /** Прочитать локальную переменную текущего фрейма по индексу `i`. */
  LOCAL_GET: "local.get",
  /** Записать в локальную переменную (значение со стека). */
  LOCAL_SET: "local.set",
  /** Сложение: снимает b, затем a; кладёт a + b. */
  ADD: "add",
  /** Вычитание: кладёт a − b. */
  SUB: "sub",
  /** Умножение: кладёт a × b. */
  MUL: "mul",
  /** Деление: кладёт a / b; деление на ноль — InterpreterError. */
  DIV: "div",
  /** Остаток: кладёт a % b; делитель 0 — InterpreterError. */
  REM: "rem",
  /** Равенство: снимает b, затем a; кладёт (a === b). */
  EQ: "eq",
  /** Неравенство: кладёт (a !== b). */
  NE: "ne",
  /** Меньше: кладёт (a < b) для чисел. */
  LT: "lt",
  /** Меньше или равно: кладёт (a <= b) для чисел. */
  LE: "le",
  /** Больше: кладёт (a > b) для чисел. */
  GT: "gt",
  /** Больше или равно: кладёт (a >= b) для чисел. */
  GE: "ge",
  /** Логическое И: кладёт Boolean(a && b). */
  AND: "and",
  /** Логическое ИЛИ: кладёт Boolean(a || b). */
  OR: "or",
  /** Логическое НЕ: снимает одно значение; кладёт !v. */
  NOT: "not",
  /** Безусловный переход: `off` — абсолютный индекс следующей инструкции в `code`. */
  JUMP: "jmp",
  /** Условный переход: снимает условие со стека; при truthy переход на `off`, иначе следующая инструкция (как в codegen для `или`). */
  JUMP_IF: "jmp_if",
  /** Условный переход: снимает условие со стека; при falsy переход на `off`, иначе следующая инструкция. */
  JUMP_IF_FALSE: "jmp_if_not",
  /** Вызов процедуры по индексу `fi` в таблице процедур; новый фрейм локалей, возврат после `ret`. */
  CALL: "call",
  /** Вызов системного API по имени; аргументы со стека (push arg0 … argN−1, затем invoke). */
  INVOKE: "invoke",
  /** Возврат из текущей процедуры (значение на вершине стека — результат, если есть). */
  RETURN: "ret",
  /** Выбросить значение с вершины стека как исключение; при наличии try — переход в catch. */
  THROW: "throw",
  /** Регистрация обработчика (байткод `try_begin`): `off` — абсолютный PC входа в catch. */
  TRY_CATCH: "try_begin",
  /** Снятие обработчика после успешного прохода try (`try_end`). Отдельного опкода finally в v0.1 нет. */
  FINALLY: "try_end",
  /** Создать объект с null-прототипом. */
  OBJ_NEW: "obj.new",
  /** Получить поле объекта по ключу со стека. */
  OBJ_GET: "obj.get",
  /** Установить поле объекта (объект под вершиной стека, см. dup + obj.set в байткоде). */
  OBJ_SET: "obj.set",
} as const satisfies Record<string, Op>;

export type OpCode = (typeof OpCode)[keyof typeof OpCode];

/**
 * Фасад стековой VM: {@link executionStack} и пошаговый {@link interpret}.
 * Опкоды исполняются в {@link VM} (наследник) через {@link interpretInstruction}:
 * {@link OpCode.PUSH} (`const` + индекс `k` в пуле констант модуля),
 * {@link OpCode.POP} (снять вершину; пустой стек → {@link InterpreterError}),
 * {@link OpCode.DUP} (копия вершины на стек),
 * {@link OpCode.ADD} / {@link OpCode.SUB} / {@link OpCode.MUL} / {@link OpCode.DIV} / {@link OpCode.REM}
 * (снять b, затем a; положить результат; при {@link OpCode.DIV}/{@link OpCode.REM} и b=0 → {@link InterpreterError}),
 * сравнения {@link OpCode.EQ} / {@link OpCode.NE} / {@link OpCode.LT} / {@link OpCode.LE} / {@link OpCode.GT} / {@link OpCode.GE},
 * логика {@link OpCode.AND} / {@link OpCode.OR} / {@link OpCode.NOT} (снятие и порядок операндов — как у арифметики, кроме {@link OpCode.NOT}: один операнд),
 * управление потоком: {@link OpCode.JUMP} (абсолютный `off`), {@link OpCode.JUMP_IF_FALSE} (снять условие; при falsy → `off`),
 * {@link OpCode.CALL} (новый фрейм по `fi`, аргументы со стека), {@link OpCode.RETURN} (`ret`: значение результата на вершине стека).
 */
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
   * После шага с числовым результатом обновляет внутренний {@link VM} PC, чтобы следующий вызов
   * совпадал с циклом {@link VM.runProcedure} (jmp/call/off задают абсолютный PC).
   */
  async interpret(ins: RawInstruction): Promise<number | "ret"> {
    const next = await this.interpretInstruction(ins);
    if (typeof next === "number") {
      this.setProgramCounter(next);
    }
    return next;
  }
}
