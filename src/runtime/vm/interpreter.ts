/**
 * Стековая машина для байткода Основа v0.1.
 * Выполняет инструкции из OsVbcModule; invoke передаётся в host (системные модули).
 */

import * as fs from "fs/promises";
import * as path from "path";
import type { OsVbcModule, RawInstruction, CodeElement } from "./bytecode";
import { getInvokeArgCount, isKnownInvoke } from "./invokeRegistry";
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

/** Обработчик по умолчанию (используется когда invoke не передан). */
function createDefaultInvokeHandler(): InvokeHandler {
  const storage = new Map<string, StackValue>();
  return (name: string, args: StackValue[]): StackValue | null => {
    switch (name) {
    case "система.массив.создать":
      return [];
    case "система.массив.добавить": {
      const arr = args[0] as StackValue[];
      if (Array.isArray(arr)) arr.push(args[1] as StackValue);
      return Array.isArray(arr) ? arr : null;
    }
    case "система.массив.установить": {
      const arr = args[0] as StackValue[];
      const idx = Number(args[1]) | 0;
      const val = args[2];
      if (Array.isArray(arr) && idx >= 0 && idx < arr.length) arr[idx] = val as StackValue;
      return null;
    }
    case "система.массив.удалить": {
      const arr = args[0] as StackValue[];
      const idx = Number(args[1]) | 0;
      if (Array.isArray(arr) && idx >= 0 && idx < arr.length) arr.splice(idx, 1);
      return null;
    }
    case "система.массив.срез": {
      const arr = args[0];
      const from = Number(args[1]) | 0;
      const to = Number(args[2]) | 0;
      return Array.isArray(arr) ? (arr as StackValue[]).slice(from, to) : [];
    }
    case "система.массив.длина":
      return Array.isArray(args[0]) ? (args[0] as StackValue[]).length : 0;
    case "система.массив.получить": {
      const arr = args[0];
      const idx = Number(args[1]) | 0;
      if (!Array.isArray(arr) || idx < 0 || idx >= arr.length) return null;
      return (arr as StackValue[])[idx] as StackValue;
    }
    case "система.строка.объединить": {
      const a = String(args[0] ?? "");
      const b = String(args[1] ?? "");
      return a + b;
    }
    case "система.строка.длина": {
      const s = String(args[0] ?? "");
      return s.length;
    }
    case "система.строка.содержит": {
      const haystack = String(args[0] ?? "");
      const needle = String(args[1] ?? "");
      return haystack.includes(needle);
    }
    case "система.строка.начинается_с": {
      const s = String(args[0] ?? "");
      const prefix = String(args[1] ?? "");
      return s.startsWith(prefix);
    }
    case "система.строка.заканчивается_на": {
      const s = String(args[0] ?? "");
      const suffix = String(args[1] ?? "");
      return s.endsWith(suffix);
    }
    case "система.строка.подстрока": {
      const s = String(args[0] ?? "");
      const start = Number(args[1] ?? 0);
      const end = Number(args[2] ?? s.length);
      return s.slice(start, end);
    }
    case "система.строка.в_верхний": {
      return String(args[0] ?? "").toUpperCase();
    }
    case "система.строка.в_нижний": {
      return String(args[0] ?? "").toLowerCase();
    }
    case "система.строка.обрезать": {
      return String(args[0] ?? "").trim();
    }
    case "система.строка.заменить": {
      const s = String(args[0] ?? "");
      const from = String(args[1] ?? "");
      const to = String(args[2] ?? "");
      return s.split(from).join(to);
    }
    case "система.строка.разделить": {
      const s = String(args[0] ?? "");
      const sep = String(args[1] ?? "");
      const parts = s.split(sep);
      return parts;
    }
    case "система.хранилище.записать": {
      const key = String(args[0] ?? "");
      storage.set(key, (args[1] ?? null) as StackValue);
      return null;
    }
    case "система.хранилище.прочитать": {
      const key = String(args[0] ?? "");
      return storage.get(key) ?? null;
    }
    case "система.хранилище.удалить": {
      const key = String(args[0] ?? "");
      storage.delete(key);
      return null;
    }
    case "система.хранилище.ключи":
      return Array.from(storage.keys());
    case "система.хранилище.ключи_с_префиксом": {
      const prefix = String(args[0] ?? "");
      return Array.from(storage.keys()).filter((k) => k.startsWith(prefix));
    }
    case "система.время.метка":
      return new Date().toISOString();
    default:
      return null;
    }
  };
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

interface TryFrame {
  catchOffset: number;
  frameDepth: number;
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
  private tryStack: TryFrame[] = [];
  private pc = 0;
  private module: OsVbcModule;
  private options: Required<InterpreterOptions>;

  constructor(module: OsVbcModule, options: InterpreterOptions = {}) {
    this.module = module;
    this.options = {
      invoke: options.invoke ?? createDefaultInvokeHandler(),
      maxSteps: options.maxSteps ?? 1_000_000,
    };
  }

  /** Доступ к стеку для тестов (readonly). Не использовать в продакшене. */
  get debugStack(): readonly StackValue[] {
    return this.stack;
  }

  /** Вершина стека без pop (для obj.set). */
  private stackPeek(): StackValue {
    return this.stack[this.stack.length - 1];
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
    this.tryStack = [];

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
            while (this.tryStack.length > 0 && this.tryStack[this.tryStack.length - 1]!.frameDepth > this.frames.length) {
              this.tryStack.pop();
            }
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
        while (this.tryStack.length > 0 && this.tryStack[this.tryStack.length - 1]!.frameDepth > this.frames.length) {
          this.tryStack.pop();
        }
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
        if (!isKnownInvoke(name)) {
          throw new InterpreterError(`Unknown invoke: ${name}`, this.pc, "invoke");
        }
        const argc = getInvokeArgCount(name);
        const args: StackValue[] = [];
        for (let i = 0; i < argc; i++) args.unshift(this.stack.pop()!);
        const result = await this.options.invoke(name, args);
        if (result !== undefined && result !== null) this.stack.push(result);
        return next;
      }
      case "jmp":
        return (ins as { op: "jmp"; off: number }).off;
      case "try_begin": {
        const off = (ins as { op: "try_begin"; off: number }).off;
        this.tryStack.push({ catchOffset: off, frameDepth: this.frames.length });
        return next;
      }
      case "try_end":
        if (this.tryStack.length > 0) this.tryStack.pop();
        return next;
      case "throw": {
        const errVal = this.stack.pop() ?? null;
        if (this.tryStack.length > 0) {
          const handler = this.tryStack.pop()!;
          // Если когда-нибудь появятся throw через frame boundaries, отрежем стек вызовов.
          while (this.frames.length > handler.frameDepth) this.frames.pop();
          this.stack.push(errVal);
          return handler.catchOffset;
        }
        // Важно: объект VM может быть с null-prototype (Object.create(null)).
        // String(obj) для таких объектов падает: "Cannot convert object to primitive value".
        let errText: string;
        if (errVal !== null && typeof errVal === "object") {
          try {
            errText = JSON.stringify(errVal);
          } catch {
            errText = "[object]";
          }
        } else {
          errText = String(errVal);
        }
        throw new InterpreterError(`Необработанное исключение: ${errText}`, this.pc, "throw");
      }
      case "jmp_if": {
        const off = (ins as { op: "jmp_if"; off: number }).off;
        if (this.stack.pop()) return off;  // truthy → jump
        return next;
      }
      case "jmp_if_not": {
        const off = (ins as { op: "jmp_if_not"; off: number }).off;
        if (!this.stack.pop()) return off;  // falsy → jump
        return next;
      }
      case "ret":
        return "ret";
      case "obj.new": {
        this.stack.push(Object.create(null) as Record<string, StackValue>);
        return next;
      }
      case "obj.get": {
        const key = this.stack.pop() as string;
        const obj = this.stack.pop();
        const val =
          obj !== null && typeof obj === "object" && !Array.isArray(obj)
            ? (obj as Record<string, StackValue>)[key] ?? null
            : null;
        this.stack.push(val);
        return next;
      }
      case "obj.set": {
        const val = this.stack.pop();
        const key = this.stack.pop() as string;
        const obj = this.stackPeek();
        if (obj !== null && typeof obj === "object" && !Array.isArray(obj)) {
          (obj as Record<string, StackValue>)[key] = val as StackValue;
        }
        return next;
      }
      case "dup": {
        this.stack.push(this.stackPeek());
        return next;
      }
      default:
        throw new InterpreterError(`Unknown op: ${(ins as RawInstruction).op}`, this.pc, (ins as RawInstruction).op);
    }
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
