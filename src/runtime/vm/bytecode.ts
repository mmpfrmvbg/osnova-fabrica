/**
 * Формат байткода Основа v0.1 (JSON .osvbc).
 * Соответствие compiler-v0.1.md: константный пул, таблица процедур, линейный код.
 *
 * ## Граница compiler / VLIW / VM
 *
 * - Поля `deps` (в `VliwPacket` и `ProcedureDef`) являются **hintами для VLIW-планировщика**
 *   (src/vliw/). VM их полностью игнорирует — это намеренное поведение, не баг.
 * - VM исполняет пакеты последовательно — slot[0], slot[1], ..., slot[N-1] —
 *   без знания и без проверки `deps`.
 * - VLIW-планировщик использует `deps` для построения графа зависимостей
 *   и переупаковки инструкций в пакеты.
 * - Отсутствие `deps` (undefined) валидно и для VM, и для планировщика
 *   (означает: зависимости не вычислены).
 *
 * **Back-compat инвариант:** добавление/изменение полей `deps`
 * не ломает VM — любой файл .osvbc с валидными `slots` продолжает работать.
 */

/**
 * Версия формата `.osvbc` — НАШЕ РЕШЕНИЕ, не из документа.
 *
 * Номер версии назначает проект, когда меняет структуру модуля. Документ
 * `docs/bytecode-v1.md` описывает именно версию 1 и говорит «Версия байткода
 * (1 для v1)» — то есть документ и код согласованы, но первоисточник здесь код,
 * а не документ.
 *
 * Почему это помечено: версия определяет, как VM читает файл. Необъяснённое
 * число здесь — это либо забытая константа, либо выдумка; отличить нельзя.
 */
export const BYTECODE_VERSION = 1;

export type ConstType = "i32" | "f64" | "str" | "bool" | "null";

/**
 * Полный список опкодов VM.
 * ПРАВИЛО: добавлять новый op ТОЛЬКО после реализации case в vm/interpreter.ts interpretInstruction().
 * Опкод в типе без обработки → Unknown op в рантайме.
 */
export type Op =
  | "const"
  | "const.true"
  | "const.false"
  | "const.null"
  | "local.get"
  | "local.set"
  | "add"
  | "sub"
  | "mul"
  | "div"
  | "idiv"
  | "rem"
  | "eq"
  | "ne"
  | "lt"
  | "le"
  | "gt"
  | "ge"
  | "and"
  | "or"
  | "not"
  | "call"
  | "invoke"
  | "jmp"
  | "jmp_if"
  | "jmp_if_not"
  | "try_begin"
  | "try_end"
  | "throw"
  | "ret"
  | "obj.new"
  | "obj.get"
  | "obj.set"
  | "dup"
  | "pop";

/**
 * Тот же набор опкодов, что {@link Op}, но доступный во время исполнения.
 *
 * Зачем: `Op` — только тип, во время работы его не существует. Из-за этого
 * инструменты (модель VLIW, отчёты, валидаторы) не могут проверить, что они не
 * разошлись с языком. Именно так `src/vliw/e2kModel.ts` и
 * `src/vliw/dependencyGraph.ts` обзавелись ветками на `global.get`,
 * `global.set`, `field.get`, `field.set`, `result.unwrap`, `result.tag` —
 * опкоды, которых в языке нет и никогда не было.
 *
 * ПРАВИЛО: при добавлении опкода в {@link Op} добавить его и сюда. Тесты
 * `src/vliw/e2kDevices.test.ts` и `src/runtime/vm/bytecode.test.ts` сверяют,
 * что наборы совпадают.
 */
export const ALL_OPS = [
  "const",
  "const.true",
  "const.false",
  "const.null",
  "local.get",
  "local.set",
  "add",
  "sub",
  "mul",
  "div",
  "idiv",
  "rem",
  "eq",
  "ne",
  "lt",
  "le",
  "gt",
  "ge",
  "and",
  "or",
  "not",
  "call",
  "invoke",
  "jmp",
  "jmp_if",
  "jmp_if_not",
  "try_begin",
  "try_end",
  "throw",
  "ret",
  "obj.new",
  "obj.get",
  "obj.set",
  "dup",
  "pop",
] as const satisfies readonly Op[];

export interface InstructionConst {
  op: "const";
  type: ConstType;
  k: number;
}

export interface InstructionLocal {
  op: "local.get" | "local.set";
  i: number;
}

export interface InstructionCall {
  op: "call";
  fi: number;
}

export interface InstructionInvoke {
  op: "invoke";
  name: string;
}

export interface InstructionJmp {
  op: "jmp" | "jmp_if" | "jmp_if_not" | "try_begin";
  off: number;
}

export type RawInstruction =
  | InstructionConst
  | InstructionLocal
  | InstructionCall
  | InstructionInvoke
  | InstructionJmp
  | { op: Exclude<Op, "const" | "local.get" | "local.set" | "call" | "invoke" | "jmp" | "jmp_if" | "jmp_if_not" | "try_begin"> };

/**
 * VLIW-пакет (format v2): несколько операций на одну позицию в code.
 *
 * `slots` — обязательный контракт VM: исполняются последовательно slot[0..N-1].
 *
 * `deps` — **hint для VLIW-планировщика** (src/vliw/), VM игнорирует.
 * Каждый элемент — пара [from, to] (индексы в потоке инструкций).
 * Отсутствие (undefined) означает, что зависимости не вычислены.
 */
export interface VliwPacket {
  packet: true;
  slots: RawInstruction[];
  deps?: [number, number][];
}

/** Элемент кода: линейная инструкция или пакет (v2). */
export type CodeElement = RawInstruction | VliwPacket;

export interface ProcedureDeps {
  blocks: { start: number; end: number }[];
  edges: [number, number][];
}

/**
 * Описание процедуры в таблице `.procedures`.
 *
 * `deps` — **hint для VLIW-планировщика** (src/vliw/), VM игнорирует.
 * Содержит граф зависимостей блоков (в v2, опционально).
 */
export interface ProcedureDef {
  name: string;
  codeOffset: number;
  argc: number;
  localsCount: number;
  returnsValue?: boolean;
  /** Процедура объявлена как `чистый` (без побочных эффектов). */
  pure?: boolean;
  /** @hint VLIW-планировщик (src/vliw/). VM игнорирует. */
  deps?: ProcedureDeps;
}

export interface OsVbcModule {
  version: number;
  moduleName: string;
  constants: unknown[];
  procedures: ProcedureDef[];
  /** Линейный код (v1) или смесь инструкций и пакетов (v2). */
  code: CodeElement[];
  /** Максимум слотов в пакете (v2, опционально). */
  vliwSlots?: number;
}

export function isOsVbcModule(m: unknown): m is OsVbcModule {
  const o = m as Record<string, unknown>;
  return (
    o &&
    typeof o.version === "number" &&
    typeof o.moduleName === "string" &&
    Array.isArray(o.constants) &&
    Array.isArray(o.procedures) &&
    Array.isArray(o.code)
  );
}

export function isVliwPacket(el: CodeElement): el is VliwPacket {
  return (
    typeof el === "object" &&
    el !== null &&
    "packet" in el &&
    (el as VliwPacket).packet === true &&
    Array.isArray((el as VliwPacket).slots)
  );
}
