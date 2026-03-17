/**
 * Стековая машина для байткода Основа v0.1.
 * Выполняет инструкции из OsVbcModule; invoke передаётся в host (системные модули).
 */

import * as fs from "fs/promises";
import * as path from "path";
import type { OsVbcModule, RawInstruction, CodeElement } from "./bytecode";
import { isVliwPacket } from "./bytecode";

export type StackValue =
  | number
  | string
  | boolean
  | null
  | Record<string, unknown>
  | StackValue[];

export interface InvokeHandler {
  (name: string, args: StackValue[]): Promise<StackValue> | StackValue;
}

export interface InterpreterOptions {
  /** Обработчик invoke (система.окно, система.файлы и т.д.) */
  invoke?: InvokeHandler;
  /** Максимум инструкций за один run (защита от бесконечного цикла) */
  maxSteps?: number;
}

interface CallFrame {
  procedureIndex: number;
  returnPc: number;
  locals: StackValue[];
}

export class InterpreterError extends Error {
  constructor(message: string, public pc?: number, public op?: string) {
    super(message);
    this.name = "InterpreterError";
  }
}

export class VM {
  private stack: StackValue[] = [];
  private frames: CallFrame[] = [];
  private pc = 0;
  private module: OsVbcModule;
  private options: Required<InterpreterOptions>;

  constructor(module: OsVbcModule, options: InterpreterOptions = {}) {
    this.module = module;
    this.options = {
      invoke: options.invoke ?? (() => null),
      maxSteps: options.maxSteps ?? 1_000_000,
    };
  }

  /** Доступ к стеку для тестов (readonly). Не использовать в продакшене. */
  get debugStack(): readonly StackValue[] {
    return this.stack;
  }

  /** Найти индекс процедуры по имени (без учёта модуля: имя процедуры). */
  findProcedureIndex(name: string): number {
    const i = this.module.procedures.findIndex((p) => p.name === name);
    if (i < 0) throw new InterpreterError(`Procedure not found: ${name}`);
    return i;
  }

  /**
   * Запуск процедуры по индексу. Аргументы передаются как начальные локальные [0..argc-1].
   * Возвращает значение на вершине стека при ret (или undefined для процедуры без возврата).
   */
  async runProcedure(procedureIndex: number, args: StackValue[]): Promise<StackValue | undefined> {
    const proc = this.module.procedures[procedureIndex];
    if (!proc) throw new InterpreterError(`Invalid procedure index: ${procedureIndex}`);

    const locals: StackValue[] = new Array(Math.max(proc.argc, proc.localsCount));
    for (let i = 0; i < proc.argc; i++) locals[i] = args[i] ?? null;
    for (let i = proc.argc; i < proc.localsCount; i++) locals[i] = null;

    this.frames.push({
      procedureIndex,
      returnPc: -1,
      locals,
    });
    this.pc = proc.codeOffset;
    this.stack = [];

    let steps = 0;
    while (this.pc >= 0 && this.pc < this.module.code.length) {
      if (++steps > this.options.maxSteps) {
        throw new InterpreterError(`Max steps exceeded (${this.options.maxSteps})`, this.pc);
      }
      const el: CodeElement = this.module.code[this.pc];
      if (isVliwPacket(el)) {
        for (const slotIns of el.slots) {
          const nextPc = await this.step(slotIns);
          if (nextPc === "ret") {
            const frame = this.frames.pop();
            if (!frame) break;
            const returnValue = this.stack.pop();
            if (this.frames.length === 0) return returnValue;
            if (returnValue !== undefined) this.stack.push(returnValue);
            this.pc = frame.returnPc;
            continue; // next iteration of while
          }
        }
        this.pc++;
        continue;
      }
      const nextPc = await this.step(el as RawInstruction);
      if (nextPc === "ret") {
        const frame = this.frames.pop();
        if (!frame) break;
        const returnValue = this.stack.pop();
        if (this.frames.length === 0) return returnValue;
        if (returnValue !== undefined) this.stack.push(returnValue);
        this.pc = frame.returnPc;
        continue;
      }
      this.pc = nextPc as number;
    }

    return undefined;
  }

  private async step(ins: RawInstruction): Promise<number | "ret"> {
    const next = this.pc + 1;

    switch (ins.op) {
      case "const": {
        const k = (ins as { op: "const"; type: string; k: number }).k;
        const v = this.module.constants[k];
        if (v === undefined) throw new InterpreterError(`Constant index out of range: ${k}`, this.pc, "const");
        this.stack.push(v as StackValue);
        return next;
      }
      case "const.true":
        this.stack.push(true);
        return next;
      case "const.false":
        this.stack.push(false);
        return next;
      case "const.null":
        this.stack.push(null);
        return next;
      case "local.get": {
        const i = (ins as { op: "local.get"; i: number }).i;
        const frame = this.frames[this.frames.length - 1];
        if (!frame || i < 0 || i >= frame.locals.length)
          throw new InterpreterError(`local.get invalid index: ${i}`, this.pc);
        this.stack.push(frame.locals[i]);
        return next;
      }
      case "local.set": {
        const i = (ins as { op: "local.set"; i: number }).i;
        const frame = this.frames[this.frames.length - 1];
        if (!frame || i < 0 || i >= frame.locals.length)
          throw new InterpreterError(`local.set invalid index: ${i}`, this.pc);
        const v = this.stack.pop();
        frame.locals[i] = v ?? null;
        return next;
      }
      case "add": {
        const b = this.stack.pop() as number;
        const a = this.stack.pop() as number;
        this.stack.push(a + b);
        return next;
      }
      case "sub": {
        const b = this.stack.pop() as number;
        const a = this.stack.pop() as number;
        this.stack.push(a - b);
        return next;
      }
      case "mul": {
        const b = this.stack.pop() as number;
        const a = this.stack.pop() as number;
        this.stack.push(a * b);
        return next;
      }
      case "div": {
        const b = this.stack.pop() as number;
        const a = this.stack.pop() as number;
        if (b === 0) throw new InterpreterError("Division by zero", this.pc, "div");
        this.stack.push(a / b);
        return next;
      }
      case "rem": {
        const b = this.stack.pop() as number;
        const a = this.stack.pop() as number;
        if (b === 0) throw new InterpreterError("Remainder by zero", this.pc, "rem");
        this.stack.push(a % b);
        return next;
      }
      case "eq":
        this.stack.push(this.stack.pop() === this.stack.pop());
        return next;
      case "ne":
        this.stack.push(this.stack.pop() !== this.stack.pop());
        return next;
      case "lt": {
        const b = this.stack.pop() as number;
        const a = this.stack.pop() as number;
        this.stack.push(a < b);
        return next;
      }
      case "le": {
        const b = this.stack.pop() as number;
        const a = this.stack.pop() as number;
        this.stack.push(a <= b);
        return next;
      }
      case "gt": {
        const b = this.stack.pop() as number;
        const a = this.stack.pop() as number;
        this.stack.push(a > b);
        return next;
      }
      case "ge": {
        const b = this.stack.pop() as number;
        const a = this.stack.pop() as number;
        this.stack.push(a >= b);
        return next;
      }
      case "call": {
        const fi = (ins as { op: "call"; fi: number }).fi;
        const proc = this.module.procedures[fi];
        if (!proc) throw new InterpreterError(`call invalid procedure index: ${fi}`, this.pc);
        const args: StackValue[] = [];
        for (let i = 0; i < proc.argc; i++) args.unshift(this.stack.pop()!);
        const locals: StackValue[] = new Array(Math.max(proc.argc, proc.localsCount));
        for (let i = 0; i < proc.argc; i++) locals[i] = args[i] ?? null;
        for (let i = proc.argc; i < proc.localsCount; i++) locals[i] = null;
        this.frames.push({ procedureIndex: fi, returnPc: next, locals });
        return proc.codeOffset;
      }
      case "invoke": {
        const name = (ins as { op: "invoke"; name: string }).name;
        const argc = this.inferInvokeArgCount(name);
        const args: StackValue[] = [];
        for (let i = 0; i < argc; i++) args.unshift(this.stack.pop()!);
        const result = await this.options.invoke(name, args);
        if (result !== undefined && result !== null) this.stack.push(result);
        return next;
      }
      case "jmp":
        return (ins as { op: "jmp"; off: number }).off;
      case "jmp_if": {
        const off = (ins as { op: "jmp_if"; off: number }).off;
        if (this.stack.pop() === true) return off;
        return next;
      }
      case "jmp_if_not": {
        const off = (ins as { op: "jmp_if_not"; off: number }).off;
        if (this.stack.pop() !== true) return off;
        return next;
      }
      case "ret":
        return "ret";
      default:
        throw new InterpreterError(`Unknown op: ${(ins as RawInstruction).op}`, this.pc, (ins as RawInstruction).op);
    }
  }

  /** Число аргументов для известных системных вызовов (по имени). */
  private inferInvokeArgCount(name: string): number {
    const args: Record<string, number> = {
      "система.лог.вывести": 1,
      "система.файлы.прочитать_все": 1,
      "система.файлы.записать_все": 2,
      "система.файлы.существует": 1,
      "система.время.сейчас": 0,
      "система.время.спать": 1,
      "система.хранилище.записать": 2,
      "система.хранилище.прочитать": 1,
      "система.хранилище.удалить": 1,
      "система.хранилище.ключи": 0,
      "система.сеть.запрос": 4,
      "система.окно.создать_окно": 3,
      "система.окно.показать": 1,
      "система.окно.скрыть": 1,
      "система.окно.закрыть": 1,
      "система.окно.установить_заголовок": 2,
      "система.окно.получить_события": 0,
      "система.интерфейс.контейнер": 3,
      "система.интерфейс.кнопка": 3,
      "система.интерфейс.поле_ввода": 3,
      "система.интерфейс.текст": 3,
      "система.интерфейс.область_текста": 3,
      "система.интерфейс.получить_значение": 1,
      "система.интерфейс.установить_значение": 2,
      "система.интерфейс.диалог_сообщение": 2,
      "система.интерфейс.диалог_подтвердить": 2,
      "система.интерфейс.диалог_ввод": 3,
      "система.массив.длина": 1,
      "система.массив.получить": 2,
      "система.объект.получить": 2,
      "система.строка.объединить": 2,
    };
    return args[name] ?? 0;
  }
}

/** Загрузить модуль из файла .osvbc или .osvbc.json */
export async function loadModule(appDir: string, moduleName: string): Promise<OsVbcModule | null> {
  const base = path.join(appDir, moduleName);
  const candidates = [base + ".osvbc.json", base + ".osvbc"];
  for (const p of candidates) {
    try {
      const raw = await fs.readFile(p, "utf-8");
      const data = JSON.parse(raw) as unknown;
      if (typeof data === "object" && data !== null && "version" in data && "code" in data) {
        return data as OsVbcModule;
      }
    } catch {
      continue;
    }
  }
  return null;
}
