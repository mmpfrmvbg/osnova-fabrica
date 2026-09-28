/**
 * Стековая машина для байткода Основа v0.1.
 * Выполняет инструкции из OsVbcModule; invoke передаётся в host (системные модули).
 */

import * as fs from "fs/promises";
import * as path from "path";
import type { OsVbcModule, RawInstruction, CodeElement } from "./bytecode";
import { getInvokeArgCount, isKnownInvoke } from "./invokeRegistry";
import { isVliwPacket } from "./bytecode";
import { RUNTIME_CODES, type RuntimeErrorCode } from "../runtimeCodes";

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
export function createDefaultInvokeHandler(): InvokeHandler {
  const storage = new Map<string, StackValue>();
  const pad2 = (n: number): string => String(Math.trunc(n)).padStart(2, "0");
  return async (name: string, args: StackValue[]): Promise<StackValue | null> => {
    switch (name) {
    case "система.массив.создать":
      return [];
    case "система.массив.добавить": {
      const arr = args[0] as StackValue[];
      if (Array.isArray(arr)) arr.push(args[1] as StackValue);
      return null;
    }
    case "система.массив.установить": {
      const target = args[0];
      const key = args[1];
      const val = args[2];
      if (Array.isArray(target)) {
        const idx = Number(key) | 0;
        if (idx >= 0 && idx < target.length) target[idx] = val as StackValue;
        return null;
      }
      if (target !== null && typeof target === "object") {
        (target as Record<string, unknown>)[String(key)] = val;
      }
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
      const target = args[0];
      const key = args[1];
      if (Array.isArray(target)) {
        const idx = Number(key) | 0;
        if (idx < 0 || idx >= target.length) return null;
        return target[idx] as StackValue;
      }
      if (target !== null && typeof target === "object") {
        return (target as Record<string, unknown>)[String(key)] as StackValue ?? null;
      }
      return null;
    }
    case "система.строка.объединить": {
      // Тот же формат значения, что у `+` со строкой: иначе `+` и `объединить`
      // расходились бы на логических (`истина` против `true`).
      return formatOsnovaValue(args[0]) + formatOsnovaValue(args[1]);
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
    case "система.строка.найти": {
      const s = String(args[0] ?? "");
      const sub = String(args[1] ?? "");
      return s.indexOf(sub);
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
    case "система.время.разобрать": {
      const raw = String(args[0] ?? "");
      const d = new Date(raw);
      return {
        год: d.getUTCFullYear(),
        месяц: d.getUTCMonth() + 1,
        день: d.getUTCDate(),
        часы: d.getUTCHours(),
        минуты: d.getUTCMinutes(),
      };
    }
    case "система.время.форматировать": {
      const dateObj = (args[0] ?? {}) as Record<string, unknown>;
      const format = String(args[1] ?? "");
      const year = Number(dateObj["год"] ?? 0);
      const month = Number(dateObj["месяц"] ?? 1);
      const day = Number(dateObj["день"] ?? 1);
      const hours = Number(dateObj["часы"] ?? 0);
      const minutes = Number(dateObj["минуты"] ?? 0);
      const dd = pad2(day);
      const mm = pad2(month);
      const yyyy = String(Math.trunc(year));
      const hh = pad2(hours);
      const min = pad2(minutes);
      if (format === "дд.мм.гггг") return `${dd}.${mm}.${yyyy}`;
      if (format === "дд.мм.гггг чч:мм") return `${dd}.${mm}.${yyyy} ${hh}:${min}`;
      return new Date(Date.UTC(year, month - 1, day, hours, minutes)).toISOString();
    }
    case "система.время.добавить_дни": {
      const iso = String(args[0] ?? "");
      const n = Number(args[1] ?? 0);
      const d = new Date(iso);
      d.setUTCDate(d.getUTCDate() + n);
      return d.toISOString();
    }
    case "система.время.разница_дней": {
      const iso1 = String(args[0] ?? "");
      const iso2 = String(args[1] ?? "");
      const d1 = new Date(iso1);
      const d2 = new Date(iso2);
      const diffDays = (d2.getTime() - d1.getTime()) / (1000 * 60 * 60 * 24);
      return Math.floor(diffDays);
    }
    case "система.лог.вывести": {
      // Печатаем ОСНОВСКИЙ вид значения: логические — словами, `пусто` — словом.
      // Голое `console.log(args[0])` давало `true`, тогда как склейка через `+`
      // давала `истина`, — одно значение выглядело по-разному в зависимости от
      // способа печати (найдено при написании учебника, 2026-09-23).
      console.log(formatOsnovaValue(args[0]));
      return null;
    }
    case "система.время.сейчас": {
      return Date.now();
    }
    case "система.строка.из_числа": {
      return String(args[0] ?? "");
    }
    case "система.объект.получить": {
      const obj = args[0];
      const key = String(args[1] ?? "");
      if (obj !== null && typeof obj === "object" && !Array.isArray(obj)) {
        return (obj as Record<string, unknown>)[key] as StackValue ?? null;
      }
      return null;
    }
    case "система.объект.ключи": {
      const obj = args[0];
      if (obj !== null && typeof obj === "object" && !Array.isArray(obj)) {
        return Object.keys(obj as Record<string, unknown>);
      }
      return [];
    }
    case "система.объект.установить": {
      const obj = args[0];
      const key = String(args[1] ?? "");
      const val = args[2] ?? null;
      if (obj !== null && typeof obj === "object" && !Array.isArray(obj)) {
        (obj as Record<string, unknown>)[key] = val;
      }
      return null;
    }
    case "система.итератор.из": {
      const src = args[0];
      if (Array.isArray(src)) return src as StackValue[];
      if (src !== null && typeof src === "object") {
        return Object.keys(src as Record<string, unknown>);
      }
      return [];
    }
    case "система.json.создать": {
      try {
        return JSON.stringify(args[0]);
      } catch {
        return "null";
      }
    }
    case "система.json.разобрать": {
      try {
        return JSON.parse(String(args[0] ?? "null")) as StackValue;
      } catch {
        return null;
      }
    }
    case "система.математика.округлить":
      return Math.round(Number(args[0] ?? 0));
    case "система.математика.пол":
      return Math.floor(Number(args[0] ?? 0));
    case "система.математика.потолок":
      return Math.ceil(Number(args[0] ?? 0));
    case "система.математика.абс":
      return Math.abs(Number(args[0] ?? 0));
    case "система.математика.макс":
      return Math.max(Number(args[0] ?? 0), Number(args[1] ?? 0));
    case "система.математика.мин":
      return Math.min(Number(args[0] ?? 0), Number(args[1] ?? 0));
    case "система.математика.степень":
      return Math.pow(Number(args[0] ?? 0), Number(args[1] ?? 0));
    case "система.математика.корень":
      return Math.sqrt(Number(args[0] ?? 0));
    case "система.математика.остаток": {
      const a = Number(args[0] ?? 0);
      const b = Number(args[1] ?? 1);
      return a % b;
    }
    case "система.оценить": {
      const raw = String(args[0] ?? "");
      const src = /^\s*модуль(?:\s|$)/.test(raw)
        ? raw
        : `модуль Внутр\nпроцедура главная()\n  вернуть ${raw}\nконец\nконец`;
      // Компилируется СТРОКА, а не файл: источник строится здесь же и несёт
      // явную шапку `модуль Внутр`, поэтому имя модуля берётся из шапки, а
      // `filename` передавать неоткуда. `baseDir` тоже не нужен: каталога нет
      // и импортов такая строка не содержит. Названо намеренно — иначе следующий
      // читатель решит, что опции забыли (аудит `.tmp/call-sites-audit.ts`).
      const { compileSource } = await import("../../compiler/compiler");
      const compiled = compileSource(src);
      if (!compiled.module || compiled.lexerErrors.length || compiled.parserErrors.length) {
        throw new Error("оценить: ошибка компиляции кода");
      }
      const subVm = new VM(compiled.module as OsVbcModule, { maxSteps: 100000 });
      const idx = subVm.findProcedureIndex("главная");
      return (await subVm.runProcedure(idx, [])) ?? null;
    }
    case "система.оценить_в": {
      const raw = String(args[0] ?? "");
      const env = (args[1] != null && typeof args[1] === "object" && !Array.isArray(args[1]))
        ? args[1] as Record<string, unknown>
        : null;
      const src = /^\s*модуль(?:\s|$)/.test(raw)
        ? raw
        : `модуль Внутр\nпроцедура главная()\n  вернуть ${raw}\nконец\nконец`;
      // Компилируется СТРОКА, а не файл: источник строится здесь же и несёт
      // явную шапку `модуль Внутр`, поэтому имя модуля берётся из шапки, а
      // `filename` передавать неоткуда. `baseDir` тоже не нужен: каталога нет
      // и импортов такая строка не содержит. Названо намеренно — иначе следующий
      // читатель решит, что опции забыли (аудит `.tmp/call-sites-audit.ts`).
      const { compileSource } = await import("../../compiler/compiler");
      const compiled = compileSource(src);
      if (!compiled.module || compiled.lexerErrors.length || compiled.parserErrors.length) {
        throw new Error("оценить_в: ошибка компиляции кода");
      }
      const base = createDefaultInvokeHandler();
      const invoke = async (name: string, a: StackValue[]): Promise<StackValue | null> => {
        if (name === "система.оценить.получить") {
          return env ? (env[String(a[0])] as StackValue) ?? null : null;
        }
        if (name === "система.оценить.установить") {
          if (env) env[String(a[0])] = a[1];
          return null;
        }
        return base(name, a);
      };
      const subVm = new VM(compiled.module as OsVbcModule, { maxSteps: 100000, invoke });
      const idx = subVm.findProcedureIndex("главная");
      return (await subVm.runProcedure(idx, [])) ?? null;
    }
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
  /**
   * Хост-вызовы вне реестра `система.*` (например `игра.очистить`).
   * Имя + argc; не пишутся в language-registry. Без записи здесь неизвестный invoke — ошибка.
   */
  extraInvokes?: ReadonlyArray<{ name: string; argc: number }>;
}

export interface RunProgramOptions extends InterpreterOptions {
  /** Явное имя процедуры точки входа (опционально). */
  entryProcedure?: string;
  /** Аргументы для точки входа. */
  entryArgs?: StackValue[];
  /** Предпочтительный модуль для поиска entry (по moduleName). */
  preferredModuleName?: string;
}

interface CallFrame {
  procedureIndex: number;
  returnPc: number;
  locals: StackValue[];
}

/** Запись обработчика `try_begin`: куда перейти при throw и глубина стека вызовов на момент входа. */
export interface TryFrame {
  catchOffset: number;
  frameDepth: number;
}

/**
 * Отказ стековой VM: текст (человеку), место в байткоде и **код** (машине).
 *
 * `code` — четвёртый параметр, а не второй: порядок `message, pc, op` закреплён
 * существующими вызовами (в т.ч. `src/compiler/compiler.ts`) и тестами, поэтому
 * новый параметр добавлен в конец и необязателен. Значения кодов — таблица
 * `src/runtime/runtimeCodes.ts`; в каждой точке броска код проставлен явно, и
 * это держит сторож `src/runtime/runtimeCodes.test.ts` (скан источников).
 */
export class InterpreterError extends Error {
  constructor(
    message: string,
    public pc?: number,
    public op?: string,
    public code?: RuntimeErrorCode,
  ) {
    super(message);
    this.name = "InterpreterError";
  }
}

/**
 * Значение программы как текст — по-основски.
 *
 * Единственное место, где решается, как выглядит значение при печати и склейке:
 * логические — словами `истина` / `ложь`, отсутствие значения — словом `пусто`,
 * массив и объект — в JSON, числа и строки — как есть.
 *
 * Почему экспортируется: тот же вид обязаны давать ВСЕ пути вывода — общий
 * обработчик, раннер приложений и CLI. Пока каждый печатал по-своему, голое
 * логическое выводилось как `true`, а в склейке через `+` — как `истина`
 * (найдено при написании учебника, 2026-09-23).
 */
export function formatOsnovaValue(v: StackValue | undefined): string {
  if (v === true) return "истина";
  if (v === false) return "ложь";
  if (v === null || v === undefined) return "пусто";
  if (typeof v === "object") {
    try {
      return JSON.stringify(v);
    } catch {
      return "[object]";
    }
  }
  return String(v);
}

export class VM {
  private stack: StackValue[] = [];
  private frames: CallFrame[] = [];
  /** Стек активных `try_begin` (верх — самый вложенный try). */
  private exceptionHandlerStack: TryFrame[] = [];
  private pc = 0;
  private module: OsVbcModule;
  private options: { invoke: InvokeHandler; maxSteps: number };
  private extraInvokeArgc: ReadonlyMap<string, number>;

  constructor(module: OsVbcModule, options: InterpreterOptions = {}) {
    this.module = module;
    this.options = {
      invoke: options.invoke ?? createDefaultInvokeHandler(),
      // ЛИМИТ ШАГОВ — НАШЕ РЕШЕНИЕ, не из стандарта и не из документа.
      //
      // Это политика безопасности: программа на Основе может содержать
      // бесконечный `цикл` (оконные приложения вроде `todo.osnova` так и
      // делают), и без лимита прогон зависнет. Значение 1_000_000 выбрано как
      // заведомо достаточное для наших программ и достаточно малое, чтобы
      // зависание обнаружилось за секунды.
      //
      // Источника в документе нет и быть не может — это наше число. Помечено
      // явно потому, что оно определяет НАБЛЮДАЕМОЕ поведение: при достижении
      // лимита VM бросает «Max steps exceeded», и оракулы трактуют это как
      // «программа не завершилась» (см. `both_hit_step_limit`).
      //
      // Аудит: `src/vliw/sourceAudit.test.ts` требует, чтобы у каждой константы
      // поведения было объяснение рядом. Без этой пометки число неотличимо от
      // выдумки.
      maxSteps: options.maxSteps ?? 1_000_000,
    };
    this.extraInvokeArgc = new Map(
      (options.extraInvokes ?? []).map((s) => [s.name, s.argc]),
    );
  }

  /** Доступ к стеку для тестов (readonly). Не использовать в продакшене. */
  get debugStack(): readonly StackValue[] {
    return this.stack;
  }

  /**
   * Активные обработчики `try_begin` (самый вложенный try — последний элемент).
   * Массив тот же, что внутри VM; не мутировать снаружи.
   */
  get activeExceptionHandlers(): readonly TryFrame[] {
    return this.exceptionHandlerStack;
  }

  /** PC после одного шага interpretInstruction (пошаговый фасад Interpreter). */
  protected setProgramCounter(next: number): void {
    this.pc = next;
  }

  /** Вершина стека без pop (для obj.set). */
  private stackPeek(): StackValue {
    return this.stack[this.stack.length - 1];
  }

  /** Найти индекс процедуры по имени (без учёта модуля: имя процедуры). */
  findProcedureIndex(name: string): number {
    const i = this.module.procedures.findIndex((p) => p.name === name);
    if (i < 0) throw new InterpreterError(`Procedure not found: ${name}`, undefined, undefined, RUNTIME_CODES.entryNotFound);
    return i;
  }

  /**
   * Запуск процедуры по индексу. Аргументы передаются как начальные локальные [0..argc-1].
   * Возвращает значение на вершине стека при ret (или undefined для процедуры без возврата).
   */
  async runProcedure(procedureIndex: number, args: StackValue[]): Promise<StackValue | undefined> {
    const proc = this.module.procedures[procedureIndex];
    if (!proc) throw new InterpreterError(`Invalid procedure index: ${procedureIndex}`, undefined, undefined, RUNTIME_CODES.entryNotFound);

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
    this.exceptionHandlerStack = [];

    let steps = 0;
    while (this.pc >= 0 && this.pc < this.module.code.length) {
      if (++steps > this.options.maxSteps) {
        throw new InterpreterError(`Max steps exceeded (${this.options.maxSteps})`, this.pc, undefined, RUNTIME_CODES.maxSteps);
      }
      const el: CodeElement = this.module.code[this.pc];
      if (isVliwPacket(el)) {
        const packetPc = this.pc;
        let exitedPacket = false;
        for (const slotIns of el.slots) {
          const nextPc = await this.interpretInstruction(slotIns);
          if (nextPc === "ret") {
            const frame = this.frames.pop();
            if (!frame) break;
            while (
              this.exceptionHandlerStack.length > 0 &&
              this.exceptionHandlerStack[this.exceptionHandlerStack.length - 1]!.frameDepth > this.frames.length
            ) {
              this.exceptionHandlerStack.pop();
            }
            const returnValue = this.stack.pop();
            if (this.frames.length === 0) return returnValue;
            if (returnValue !== undefined) this.stack.push(returnValue);
            this.pc = frame.returnPc;
            exitedPacket = true;
            break;
          }
          // jmp / call / throw / и т.п. — абсолютный nextPc, не следующий за пакетом
          if (nextPc !== packetPc + 1) {
            this.pc = nextPc as number;
            exitedPacket = true;
            break;
          }
        }
        if (!exitedPacket) this.pc = packetPc + 1;
        continue;
      }
      const nextPc = await this.interpretInstruction(el as RawInstruction);
      if (nextPc === "ret") {
        const frame = this.frames.pop();
        if (!frame) break;
        while (
          this.exceptionHandlerStack.length > 0 &&
          this.exceptionHandlerStack[this.exceptionHandlerStack.length - 1]!.frameDepth > this.frames.length
        ) {
          this.exceptionHandlerStack.pop();
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

  /**
   * Разбор и выполнение одной сырой инструкции (не VLIW-обёртка).
   * Используется циклом {@link runProcedure}; protected — для фасада `Interpreter` в interpreter.ts (пошаговый вызов).
   */
  protected async interpretInstruction(ins: RawInstruction): Promise<number | "ret"> {
    const next = this.pc + 1;

    switch (ins.op) {
      case "const": {
        const k = (ins as { op: "const"; type: string; k: number }).k;
        const v = this.module.constants[k];
        if (v === undefined) throw new InterpreterError(`Constant index out of range: ${k}`, this.pc, "const", RUNTIME_CODES.internalInvariant);
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
          throw new InterpreterError(`local.get invalid index: ${i}`, this.pc, undefined, RUNTIME_CODES.internalInvariant);
        this.stack.push(frame.locals[i]);
        return next;
      }
      case "local.set": {
        const i = (ins as { op: "local.set"; i: number }).i;
        const frame = this.frames[this.frames.length - 1];
        if (!frame || i < 0 || i >= frame.locals.length)
          throw new InterpreterError(`local.set invalid index: ${i}`, this.pc, undefined, RUNTIME_CODES.internalInvariant);
        const v = this.stack.pop();
        frame.locals[i] = v ?? null;
        return next;
      }
      case "add": {
        const b = this.stack.pop();
        const a = this.stack.pop();
        if (typeof a === "string" || typeof b === "string") {
          this.stack.push(formatOsnovaValue(a) + formatOsnovaValue(b));
          return next;
        }
        this.stack.push((a as number) + (b as number));
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
        if (b === 0) throw new InterpreterError("Division by zero", this.pc, "div", RUNTIME_CODES.divisionByZero);
        this.stack.push(a / b);
        return next;
      }
      case "idiv": {
        // БЛОК 2: целочисленное деление — отсечение К НУЛЮ (как `SDIVs` в e2k и
        // как остаток `rem` в этом же интерпретаторе: знак — по делимому).
        const b = this.stack.pop() as number;
        const a = this.stack.pop() as number;
        if (b === 0) throw new InterpreterError("Integer division by zero", this.pc, "idiv", RUNTIME_CODES.divisionByZero);
        this.stack.push(Math.trunc(a / b));
        return next;
      }
      case "rem": {
        const b = this.stack.pop() as number;
        const a = this.stack.pop() as number;
        if (b === 0) throw new InterpreterError("Remainder by zero", this.pc, "rem", RUNTIME_CODES.remainderByZero);
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
      case "and": {
        const b = this.stack.pop();
        const a = this.stack.pop();
        this.stack.push(Boolean(a && b));
        return next;
      }
      case "or": {
        const b = this.stack.pop();
        const a = this.stack.pop();
        this.stack.push(Boolean(a || b));
        return next;
      }
      case "not": {
        const v = this.stack.pop();
        this.stack.push(!v);
        return next;
      }
      case "call": {
        const fi = (ins as { op: "call"; fi: number }).fi;
        const proc = this.module.procedures[fi];
        if (!proc) throw new InterpreterError(`call invalid procedure index: ${fi}`, this.pc, undefined, RUNTIME_CODES.internalInvariant);
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
        const extraArgc = this.extraInvokeArgc.get(name);
        if (!isKnownInvoke(name) && extraArgc === undefined) {
          throw new InterpreterError(`Unknown invoke: ${name}`, this.pc, "invoke", RUNTIME_CODES.unknownInvoke);
        }
        const argc = extraArgc !== undefined ? extraArgc : getInvokeArgCount(name);
        const args: StackValue[] = [];
        for (let i = 0; i < argc; i++) args.unshift(this.stack.pop()!);
        const result = await this.options.invoke(name, args);
        this.stack.push(result === undefined ? null : result);
        return next;
      }
      case "jmp":
        return (ins as { op: "jmp"; off: number }).off;
      case "try_begin": {
        const off = (ins as { op: "try_begin"; off: number }).off;
        this.exceptionHandlerStack.push({ catchOffset: off, frameDepth: this.frames.length });
        return next;
      }
      case "try_end":
        if (this.exceptionHandlerStack.length > 0) this.exceptionHandlerStack.pop();
        return next;
      case "throw": {
        const errVal = this.stack.pop() ?? null;
        if (this.exceptionHandlerStack.length > 0) {
          const handler = this.exceptionHandlerStack.pop()!;
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
        throw new InterpreterError(`Необработанное исключение: ${errText}`, this.pc, "throw", RUNTIME_CODES.unhandledThrow);
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
      case "pop": {
        if (this.stack.length === 0) {
          throw new InterpreterError("Stack underflow on pop", this.pc, "pop", RUNTIME_CODES.internalInvariant);
        }
        this.stack.pop();
        return next;
      }
      default:
        throw new InterpreterError(`Unknown op: ${(ins as RawInstruction).op}`, this.pc, (ins as RawInstruction).op, RUNTIME_CODES.internalInvariant);
    }
  }

}

interface ProcedureLocation {
  module: OsVbcModule;
  moduleIndex: number;
  procedureIndex: number;
}

function resolveProgramEntry(
  modules: OsVbcModule[],
  procedureRegistry: Map<string, ProcedureLocation>,
  options: RunProgramOptions,
): ProcedureLocation {
  const firstModule = modules[0];
  if (!firstModule || firstModule.procedures.length === 0) {
    throw new InterpreterError("Program has no procedures in the first module", undefined, undefined, RUNTIME_CODES.entryNotFound);
  }

  if (options.entryProcedure) {
    const direct = procedureRegistry.get(options.entryProcedure);
    if (direct) return direct;
    const prefixed = procedureRegistry.get(`${firstModule.moduleName}__${options.entryProcedure}`);
    if (prefixed) return prefixed;
  }

  const preferredModule =
    options.preferredModuleName != null
      ? modules.find((m) => m.moduleName === options.preferredModuleName) ?? firstModule
      : firstModule;

  const preferredNames = new Set(preferredModule.procedures.map((p) => p.name));
  const firstNames = new Set(firstModule.procedures.map((p) => p.name));

  const lookupOrdered = [
    "главная",
    `${preferredModule.moduleName}__главная`,
    `${firstModule.moduleName}__главная`,
    "main",
    `${preferredModule.moduleName}__main`,
    `${firstModule.moduleName}__main`,
  ];

  for (const name of lookupOrdered) {
    const loc = procedureRegistry.get(name);
    if (loc && (preferredNames.has(name) || firstNames.has(name))) return loc;
  }

  const fallback = procedureRegistry.get(firstModule.procedures[0]!.name);
  if (!fallback) {
    throw new InterpreterError("Entry point not found: neither главная/main nor first procedure exists", undefined, undefined, RUNTIME_CODES.entryNotFound);
  }
  return fallback;
}

export async function runProgram(
  modules: OsVbcModule[],
  options: RunProgramOptions = {},
): Promise<void> {
  if (!Array.isArray(modules) || modules.length === 0) {
    throw new InterpreterError("Program is empty: no modules provided", undefined, undefined, RUNTIME_CODES.entryNotFound);
  }

  const procedureRegistry = new Map<string, ProcedureLocation>();
  for (let moduleIndex = 0; moduleIndex < modules.length; moduleIndex++) {
    const module = modules[moduleIndex]!;
    for (let procedureIndex = 0; procedureIndex < module.procedures.length; procedureIndex++) {
      const proc = module.procedures[procedureIndex]!;
      if (!procedureRegistry.has(proc.name)) {
        procedureRegistry.set(proc.name, { module, moduleIndex, procedureIndex });
      }
    }
  }

  const entry = resolveProgramEntry(modules, procedureRegistry, options);
  const vm = new VM(entry.module, {
    invoke: options.invoke,
    maxSteps: options.maxSteps,
  });
  await vm.runProcedure(entry.procedureIndex, options.entryArgs ?? []);
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
