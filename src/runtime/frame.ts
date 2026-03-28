/**
 * Кадр вызова: состояние исполнения процедуры (ip, локали, операндный стек).
 * Значения в locals/stack структурно совпадают с StackValue в vm/interpreter.ts.
 */

/** Ячейка стека/локалей кадра (как StackValue в интерпретаторе). */
export type FrameValue =
  | number
  | string
  | boolean
  | null
  | Record<string, unknown>
  | FrameValue[];

/** Снимок/описание кадра для VM и отладки. */
export interface CallFrame {
  ip: number;
  fp: number;
  locals: FrameValue[];
  stack: FrameValue[];
}

/** Изменяемый кадр с операциями над слотами локалей. */
export class Frame implements CallFrame {
  ip = 0;
  fp = 0;
  locals: FrameValue[] = [];
  stack: FrameValue[] = [];

  pushLocal(value: FrameValue): void {
    this.locals.push(value);
  }

  popLocal(): FrameValue | undefined {
    return this.locals.pop();
  }
}
