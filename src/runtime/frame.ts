/**
 * Кадр вызова: состояние исполнения процедуры (ip, локали, операндный стек).
 * Значения в locals/stack — те же, что {@link StackValue} в vm/interpreter.ts.
 */

import type { StackValue } from "./vm/interpreter";

/** Ячейка стека/локалей кадра (алиас StackValue для импорта из интерпретатора). */
export type FrameValue = StackValue;

/** Снимок/описание кадра для VM и отладки. */
export interface CallFrame {
  ip: number;
  fp: number;
  locals: StackValue[];
  stack: StackValue[];
}

/** Изменяемый кадр с операциями над слотами локалей. */
export class Frame implements CallFrame {
  ip = 0;
  fp = 0;
  locals: StackValue[] = [];
  stack: StackValue[] = [];

  pushLocal(value: StackValue): void {
    this.locals.push(value);
  }

  popLocal(): StackValue | undefined {
    return this.locals.pop();
  }
}
