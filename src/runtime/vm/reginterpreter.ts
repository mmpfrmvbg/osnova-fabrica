/**
 * Регистровая VM: исполняет байткод из {@link import("./regcode")}.
 *
 * Семантика каждого опкода **обязана** совпадать со стековой VM
 * (`src/runtime/vm/interpreter.ts`): это условие существования формата, а не
 * деталь реализации. Расхождение ловится дифференциальным оракулом
 * (`src/oracle/parity.ts`) на одном и том же `.osnova`-исходнике.
 *
 * Что перенесено из стековой VM дословно:
 * - пул констант и `const.k` (тот же индекс, тот же `constants[]`);
 * - `add` со строками — конкатенация через строковое представление;
 * - деление/остаток на ноль → ошибка;
 * - `eq`/`ne` — строгое сравнение (приведение к элементам стека, как `pop() === pop()`);
 * - `invoke` — проверка известности имени и арности через `invokeRegistry`, как у хоста;
 * - `obj.new` — объект без прототипа (`Object.create(null)`);
 * - объект/массив — ссылки с мутацией (копия регистра копирует ссылку, не значение);
 * - вызовы: аргументы — это регистры `0..argc-1` вызываемой процедуры, окно
 *   регистров вызывающего сохраняется целиком.
 *
 * @remarks
 * Регистровый файл — массив на кадр (`values`), а не одно большое окно: при
 * вызове кадр создаётся заново, поэтому «окно вызывающего» сохраняется само
 * собой, а глубина рекурсии ограничена только стеком вызовов.
 */

import type {
  RegCodeElement,
  RegInstruction,
  RegModule,
  RegProcedure,
} from "./regcode";
import { isRegPacket } from "./regcode";
import { getInvokeArgCount, isKnownInvoke } from "./invokeRegistry";
import type { InvokeHandler, StackValue } from "./interpreter";
// Формат значения — один на все VM: своя копия здесь разошлась бы с общей, и
// склейка строк в регистровой машине печатала бы логическое иначе, чем в стековой.
import { formatOsnovaValue } from "./interpreter";
// Коды отказа — общее пространство обеих VM: код `OSN-RT-002` обязан значить
// одно и то же в стековой и в регистровой машине, иначе по журналу нельзя
// считать частоты (см. `src/runtime/runtimeCodes.ts`).
import { RUNTIME_CODES, type RuntimeErrorCode } from "../runtimeCodes";

export type { StackValue };

/**
 * Ошибка регистровой VM: сообщение + место в регистровом коде + код отказа.
 *
 * `code` — четвёртый параметр (как у `InterpreterError`): порядок
 * `message, pc, op` закреплён вызовами и оракулами, поэтому новый параметр
 * добавлен в конец. Проставлен в каждой точке броска; сторож —
 * `src/runtime/runtimeCodes.test.ts` (скан источников).
 */
export class RegInterpreterError extends Error {
  constructor(
    message: string,
    public pc?: number,
    public op?: string,
    public code?: RuntimeErrorCode,
  ) {
    super(message);
    this.name = "RegInterpreterError";
  }
}

/**
 * Шаг трассы: вызов хоста. Сравнение трасс — то, что отличает паритет от
 * совпадения итога: одно и то же возвращаемое значение может быть получено
 * разной последовательностью вызовов.
 *
 * Возвраты из вложенных процедур в трассу **не** пишутся: стековая VM их наружу
 * не отдаёт, и оракул сравнивал бы разные определения трассы, а не поведение.
 */
export interface RegTraceStep {
  kind: "invoke";
  name: string;
  args: StackValue[];
}

export interface RegInterpreterOptions {
  /** Обработчик `invoke`; по умолчанию — хост-заглушка без системных модулей. */
  invoke?: InvokeHandler;
  /** Максимум инструкций за один прогон (защита от бесконечного цикла). */
  maxSteps?: number;
  /** Хост-вызовы вне реестра `система.*` (имя + argc), как в стековой VM. */
  extraInvokes?: ReadonlyArray<{ name: string; argc: number }>;
  /** Наблюдатель шагов (дифференциальный оракул, отладка). */
  trace?: (step: RegTraceStep) => void;
  /**
   * Наблюдатель **исполнения**: вызывается на каждую исполняемую инструкцию с
   * её адресом и позицией в пакете. Нужен оракулу VLIW-планировщика: он должен
   * видеть, что упакованный код исполнил тот же **набор** инструкций, а не
   * только что совпали итог и вызовы хоста. Порядок при этом может отличаться —
   * планировщик для того и переставляет независимые инструкции.
   */
  onExecute?: (info: { pc: number; slotIndex: number; op: string }) => void;
}

interface RegFrame {
  procedureIndex: number;
  returnPc: number;
  /** Регистровый файл кадра. */
  values: StackValue[];
  /**
   * Инструкция, которая вызвала эту процедуру (`call`), — чтобы вернуть
   * значение именно в её регистр-приёмник. Для самой внешней процедуры нет.
   */
  callerElement?: RegInstruction;
}

/**
 * Обработчик защищённого блока: адрес `иначе_попытка`, регистр переменной-
 * приёмника и глубина кадров на момент входа (до неё разворачиваем стек вызовов).
 */
interface TryFrame {
  catchOffset: number;
  catchReg: number;
  frameDepth: number;
}

function describeValue(v: StackValue | undefined): string {
  if (v !== null && typeof v === "object") {
    try {
      return JSON.stringify(v);
    } catch {
      return "[object]";
    }
  }
  return String(v);
}

export class RegVM {
  private readonly module: RegModule;
  private readonly invoke: InvokeHandler;
  private readonly maxSteps: number;
  private readonly extraInvokeArgc: ReadonlyMap<string, number>;
  private readonly trace?: (step: RegTraceStep) => void;
  private readonly onExecute?: (info: { pc: number; slotIndex: number; op: string }) => void;
  private frames: RegFrame[] = [];
  /** Активные обработчики `try_begin` (верх — самый вложенный блок). */
  private tryStack: TryFrame[] = [];
  private pc = 0;
  /**
   * Значение последнего `ret`, снявшего последний кадр. `step()` сообщает
   * вызывающему только «процедура завершилась» (`"ret"`), а само значение
   * лежит здесь — иначе оно терялось бы на выходе из цикла.
   */
  private lastReturn: StackValue | undefined = undefined;

  constructor(module: RegModule, options: RegInterpreterOptions = {}) {
    this.module = module;
    this.invoke = options.invoke ?? (() => null);
    // ЛИМИТ ШАГОВ — НАШЕ РЕШЕНИЕ (политика, не документ). То же значение и тот
    // же смысл, что в стековой VM: защита от бесконечного `цикл`. Счётчик
    // инкрементируется на ЭЛЕМЕНТ кода (пакет — один шаг), а не на инструкцию —
    // поэтому при равном лимите упакованный код исполняет больше инструкций.
    // Это учтено в оракулах (`both_hit_step_limit`, `not_comparable`).
    this.maxSteps = options.maxSteps ?? 1_000_000;
    this.extraInvokeArgc = new Map(
      (options.extraInvokes ?? []).map((s) => [s.name, s.argc]),
    );
    this.trace = options.trace;
    this.onExecute = options.onExecute;
  }

  /** Индекс процедуры по имени; бросает, если нет (как `VM.findProcedureIndex`). */
  findProcedureIndex(name: string): number {
    const i = this.module.procedures.findIndex((p) => p.name === name);
    if (i < 0) throw new RegInterpreterError(`Procedure not found: ${name}`, undefined, undefined, RUNTIME_CODES.entryNotFound);
    return i;
  }

  /**
   * Запуск процедуры по индексу. Аргументы кладутся в регистры `0..argc-1`.
   * Возвращает значение из `ret` (или `undefined`, если процедура завершилась без значения).
   */
  async runProcedure(
    procedureIndex: number,
    args: StackValue[] = [],
  ): Promise<StackValue | undefined> {
    const proc = this.module.procedures[procedureIndex];
    if (!proc) {
      throw new RegInterpreterError(`Invalid procedure index: ${procedureIndex}`, undefined, undefined, RUNTIME_CODES.entryNotFound);
    }

    this.frames = [this.createFrame(proc, procedureIndex, -1, args)];
    this.tryStack = [];
    this.pc = proc.codeOffset;
    this.lastReturn = undefined;

    let steps = 0;
    while (this.pc >= 0 && this.pc < this.module.code.length) {
      if (++steps > this.maxSteps) {
        throw new RegInterpreterError(
          `Max steps exceeded (${this.maxSteps})`,
          this.pc,
          undefined,
          RUNTIME_CODES.maxSteps,
        );
      }
      const element = this.module.code[this.pc];
      if (!element) {
        throw new RegInterpreterError(`Нет инструкции по адресу ${this.pc}`, this.pc, undefined, RUNTIME_CODES.internalInvariant);
      }
      const next = await this.executeElement(element);
      if (next === "ret") return this.lastReturn;
      this.pc = next;
    }

    return undefined;
  }

  /**
   * Один элемент кода: инструкция или VLIW-пакет.
   *
   * Слоты пакета исполняются последовательно, как в стековой VM. Пакет
   * покидается, как только слот передал управление (переход или возврат) —
   * планировщик гарантирует, что `jmp*`/`ret` занимают пакет целиком, но
   * проверка оставлена: она делает контракт явным.
   */
  private async executeElement(element: RegCodeElement): Promise<number | "ret"> {
    if (!isRegPacket(element)) {
      this.onExecute?.({ pc: this.pc, slotIndex: 0, op: (element as RegInstruction).op });
      return this.step(element as RegInstruction);
    }
    const packetPc = this.pc;
    for (let i = 0; i < element.slots.length; i++) {
      const slot = element.slots[i]!;
      this.onExecute?.({ pc: packetPc, slotIndex: i, op: slot.op });
      const next = await this.step(slot);
      if (next === "ret") return "ret";
      if (next !== packetPc + 1) return next;
    }
    return packetPc + 1;
  }

  /** Кадр процедуры: регистры `0..argc-1` — аргументы, остальные — `null`. */
  private createFrame(
    proc: RegProcedure,
    procedureIndex: number,
    returnPc: number,
    args: StackValue[],
    callerElement?: RegInstruction,
  ): RegFrame {
    const values: StackValue[] = new Array(Math.max(proc.vregs, proc.argc)).fill(null);
    for (let i = 0; i < proc.argc; i++) values[i] = args[i] ?? null;
    return { procedureIndex, returnPc, values, callerElement };
  }

  private frame(): RegFrame {
    const frame = this.frames[this.frames.length - 1];
    if (!frame) throw new RegInterpreterError("Нет активного кадра", this.pc, undefined, RUNTIME_CODES.internalInvariant);
    return frame;
  }

  private read(reg: number): StackValue {
    const values = this.frame().values;
    if (reg < 0 || reg >= values.length) {
      throw new RegInterpreterError(`Регистр вне диапазона: r${reg}`, this.pc, "read", RUNTIME_CODES.internalInvariant);
    }
    return values[reg] as StackValue;
  }

  private write(reg: number, value: StackValue): void {
    const values = this.frame().values;
    if (reg < 0 || reg >= values.length) {
      throw new RegInterpreterError(`Регистр вне диапазона: r${reg}`, this.pc, "write", RUNTIME_CODES.internalInvariant);
    }
    values[reg] = value;
  }

  private writeIfAny(reg: number | undefined, value: StackValue): void {
    if (reg !== undefined) this.write(reg, value);
  }

  /** Один шаг: возвращает следующий pc или строку `ret` (процедура завершилась). */
  private async step(ins: RegInstruction): Promise<number | "ret"> {
    const next = this.pc + 1;
    switch (ins.op) {
      case "const": {
        const v = this.module.constants[ins.k];
        if (v === undefined) {
          throw new RegInterpreterError(
            `Constant index out of range: ${ins.k}`,
            this.pc,
            "const",
            RUNTIME_CODES.internalInvariant,
          );
        }
        this.write(ins.d, v as StackValue);
        return next;
      }
      case "const.true":
        this.write(ins.d, true);
        return next;
      case "const.false":
        this.write(ins.d, false);
        return next;
      case "const.null":
        this.write(ins.d, null);
        return next;
      case "move":
        this.write(ins.d, this.read(ins.a));
        return next;
      case "add": {
        const b = this.read(ins.b);
        const a = this.read(ins.a);
        if (typeof a === "string" || typeof b === "string") {
          this.write(ins.d, formatOsnovaValue(a) + formatOsnovaValue(b));
          return next;
        }
        this.write(ins.d, (a as number) + (b as number));
        return next;
      }
      case "sub":
        this.write(ins.d, (this.read(ins.a) as number) - (this.read(ins.b) as number));
        return next;
      case "mul":
        this.write(ins.d, (this.read(ins.a) as number) * (this.read(ins.b) as number));
        return next;
      case "div": {
        const a = this.read(ins.a) as number;
        const b = this.read(ins.b) as number;
        if (b === 0) throw new RegInterpreterError("Division by zero", this.pc, "div", RUNTIME_CODES.divisionByZero);
        this.write(ins.d, a / b);
        return next;
      }
      case "idiv": {
        // БЛОК 2: целочисленное деление — отсечение к нулю (как `SDIVs` в e2k).
        const a = this.read(ins.a) as number;
        const b = this.read(ins.b) as number;
        if (b === 0) throw new RegInterpreterError("Integer division by zero", this.pc, "idiv", RUNTIME_CODES.divisionByZero);
        this.write(ins.d, Math.trunc(a / b));
        return next;
      }
      case "rem": {
        const a = this.read(ins.a) as number;
        const b = this.read(ins.b) as number;
        if (b === 0) {
          throw new RegInterpreterError("Remainder by zero", this.pc, "rem", RUNTIME_CODES.remainderByZero);
        }
        this.write(ins.d, a % b);
        return next;
      }
      case "eq":
        this.write(ins.d, this.read(ins.a) === this.read(ins.b));
        return next;
      case "ne":
        this.write(ins.d, this.read(ins.a) !== this.read(ins.b));
        return next;
      case "lt":
        this.write(ins.d, (this.read(ins.a) as number) < (this.read(ins.b) as number));
        return next;
      case "le":
        this.write(ins.d, (this.read(ins.a) as number) <= (this.read(ins.b) as number));
        return next;
      case "gt":
        this.write(ins.d, (this.read(ins.a) as number) > (this.read(ins.b) as number));
        return next;
      case "ge":
        this.write(ins.d, (this.read(ins.a) as number) >= (this.read(ins.b) as number));
        return next;
      case "and":
        this.write(ins.d, Boolean(this.read(ins.a) && this.read(ins.b)));
        return next;
      case "or":
        this.write(ins.d, Boolean(this.read(ins.a) || this.read(ins.b)));
        return next;
      case "not":
        this.write(ins.d, !this.read(ins.a));
        return next;
      case "invoke": {
        const extraArgc = this.extraInvokeArgc.get(ins.name);
        if (!isKnownInvoke(ins.name) && extraArgc === undefined) {
          throw new RegInterpreterError(
            `Unknown invoke: ${ins.name}`,
            this.pc,
            "invoke",
            RUNTIME_CODES.unknownInvoke,
          );
        }
        const argc = extraArgc !== undefined ? extraArgc : getInvokeArgCount(ins.name);
        if (ins.argc !== argc) {
          throw new RegInterpreterError(
            `invoke ${ins.name}: ожидалось аргументов ${argc}, в коде ${ins.argc}`,
            this.pc,
            "invoke",
            RUNTIME_CODES.internalInvariant,
          );
        }
        const args: StackValue[] = [];
        for (let i = 0; i < argc; i++) args.push(this.read(ins.args[i] ?? -1));
        const result = await this.invoke(ins.name, args);
        this.trace?.({ kind: "invoke", name: ins.name, args: args.slice() });
        this.writeIfAny(ins.d, result === undefined ? null : result);
        return next;
      }
      case "call": {
        const callee = this.module.procedures[ins.fi];
        if (!callee) {
          throw new RegInterpreterError(`call invalid procedure index: ${ins.fi}`, this.pc, undefined, RUNTIME_CODES.internalInvariant);
        }
        const args: StackValue[] = [];
        for (let i = 0; i < ins.argc; i++) args.push(this.read(ins.args[i] ?? -1));
        this.frames.push(this.createFrame(callee, ins.fi, next, args, ins));
        return callee.codeOffset;
      }
      case "jmp":
        return ins.off;
      case "jmp_if":
        return this.read(ins.cond ?? -1) ? ins.off : next;
      case "jmp_if_not":
        return this.read(ins.cond ?? -1) ? next : ins.off;
      case "try_begin":
        // Границы блока запоминаются вместе с глубиной кадров: при `throw`
        // кадры снимаются до неё, как в стековой VM.
        this.tryStack.push({
          catchOffset: ins.off,
          catchReg: ins.catchReg,
          frameDepth: this.frames.length,
        });
        return next;
      case "try_end":
        this.tryStack.pop();
        return next;
      case "throw": {
        const errVal = ins.a === undefined ? null : this.read(ins.a);
        const handler = this.tryStack.pop();
        if (handler === undefined) {
          throw new RegInterpreterError(
            `Необработанное исключение: ${describeValue(errVal)}`,
            this.pc,
            "throw",
            RUNTIME_CODES.unhandledThrow,
          );
        }
        // Разворачивание: снять кадры, накопленные внутри защищённого блока.
        while (this.frames.length > handler.frameDepth) this.frames.pop();
        // Пойманное значение кладём прямо в регистр переменной `иначе_попытка`
        // (он записан в `try_begin`): ни стек, ни отдельный регистр не нужны.
        this.write(handler.catchReg, errVal);
        return handler.catchOffset;
      }
      case "ret": {
        const value = ins.v === undefined ? undefined : this.read(ins.v);
        const frame = this.frames.pop();
        if (!frame) {
          throw new RegInterpreterError("ret без кадра", this.pc, "ret", RUNTIME_CODES.internalInvariant);
        }
        // Досрочный выход из процедуры снимает и её незакрытые защищённые блоки
        // (то же делает стековая VM), иначе обработчик «мёртвого» кадра остался
        // бы в стеке и перехватил чужое исключение.
        while (
          this.tryStack.length > 0 &&
          this.tryStack[this.tryStack.length - 1]!.frameDepth > this.frames.length
        ) {
          this.tryStack.pop();
        }
        if (this.frames.length === 0) {
          // Возврат из самой внешней процедуры — это значение прогона, а не
          // событие внутри программы; трассу он не пополняет.
          //
          // `undefined` нормализуется в `null` так же, как для вложенного вызова
          // ниже: стековая VM отдаёт наружу `null` («вернуть» без значения), и
          // без нормализации оракул паритета видел расхождение `null`/`undefined`
          // на `storage_demo.osnova` и `блокнот.osnova`.
          this.lastReturn = value === undefined ? null : value;
          return "ret";
        }
        // Возврат из вложенного вызова: результат — в регистр вызывающего.
        // Вызывающая инструкция записана при `call`, а не выводится из `returnPc`:
        // в упакованном коде `returnPc - 1` может указывать внутрь пакета.
        const callIns = frame.callerElement;
        if (callIns !== undefined && (callIns.op === "invoke" || callIns.op === "call")) {
          this.writeIfAny(callIns.d, value === undefined ? null : value);
        }
        return frame.returnPc;
      }
      case "obj.new":
        this.write(ins.d, Object.create(null) as Record<string, StackValue>);
        return next;
      case "obj.get": {
        const key = this.read(ins.key);
        const target = this.read(ins.a);
        const val =
          target !== null && typeof target === "object" && !Array.isArray(target)
            ? ((target as Record<string, StackValue>)[String(key)] ?? null)
            : null;
        this.writeIfAny(ins.d, val);
        return next;
      }
      case "obj.set": {
        const target = this.read(ins.a);
        const key = this.read(ins.key);
        const val = ins.b === undefined ? null : this.read(ins.b);
        if (target !== null && typeof target === "object" && !Array.isArray(target)) {
          (target as Record<string, StackValue>)[String(key)] = val;
        }
        // Как в стековой VM: `obj.set` оставляет объект на месте (в регистре `a`).
        return next;
      }
      default: {
        const unknown = ins as { op?: string };
        throw new RegInterpreterError(
          `Unknown op: ${unknown.op ?? "?"}`,
          this.pc,
          unknown.op,
          RUNTIME_CODES.internalInvariant,
        );
      }
    }
  }

  /** Имя процедуры текущего кадра (для диагностики). */
  currentProcedureName(): string | undefined {
    const frame = this.frames[this.frames.length - 1];
    if (!frame) return undefined;
    return this.module.procedures[frame.procedureIndex]?.name;
  }

  /** Отладочный доступ к регистрам текущего кадра (только для тестов). */
  debugRegisters(): readonly StackValue[] {
    const frame = this.frames[this.frames.length - 1];
    return frame ? frame.values : [];
  }
}

/**
 * Запуск процедуры `главная` (или первой процедуры модуля) в регистровой VM.
 * Отдельная функция — чтобы тесты и оракул не повторяли разрешение точки входа.
 */
export async function runRegProgram(
  module: RegModule,
  options: RegInterpreterOptions = {},
  args: StackValue[] = [],
  entryProcedure?: string,
): Promise<StackValue | undefined> {
  const vm = new RegVM(module, options);
  const index =
    entryProcedure !== undefined ? vm.findProcedureIndex(entryProcedure) : defaultEntryIndex(module);
  return vm.runProcedure(index, args);
}

function defaultEntryIndex(module: RegModule): number {
  for (const name of ["главная", "main"]) {
    const i = module.procedures.findIndex((p) => p.name === name);
    if (i >= 0) return i;
  }
  if (module.procedures.length === 0) {
    throw new RegInterpreterError("Регистровый модуль без процедур", undefined, undefined, RUNTIME_CODES.entryNotFound);
  }
  return 0;
}
