/**
 * Формат байткода Основа v0.1 (JSON .osvbc).
 * Соответствие compiler-v0.1.md: константный пул, таблица процедур, линейный код.
 */

export const BYTECODE_VERSION = 1;

export type ConstType = "i32" | "f64" | "str" | "bool" | "null";

export type Op =
  | "const"
  | "const.true"
  | "const.false"
  | "const.null"
  | "local.get"
  | "local.set"
  | "global.get"
  | "global.set"
  | "add"
  | "sub"
  | "mul"
  | "div"
  | "rem"
  | "eq"
  | "ne"
  | "lt"
  | "le"
  | "gt"
  | "ge"
  | "call"
  | "invoke"
  | "jmp"
  | "jmp_if"
  | "jmp_if_not"
  | "ret"
  | "result.unwrap"
  | "result.tag";

export interface InstructionConst {
  op: "const";
  type: ConstType;
  k: number;
}

export interface InstructionLocal {
  op: "local.get" | "local.set";
  i: number;
}

export interface InstructionGlobal {
  op: "global.get" | "global.set";
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
  op: "jmp" | "jmp_if" | "jmp_if_not";
  off: number;
}

export type RawInstruction =
  | InstructionConst
  | InstructionLocal
  | InstructionGlobal
  | InstructionCall
  | InstructionInvoke
  | InstructionJmp
  | { op: Exclude<Op, "const" | "local.get" | "local.set" | "global.get" | "global.set" | "call" | "invoke" | "jmp" | "jmp_if" | "jmp_if_not"> };

/** VLIW-пакет (format v2): несколько операций на одну позицию в code. */
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

export interface ProcedureDef {
  name: string;
  codeOffset: number;
  argc: number;
  localsCount: number;
  returnsValue?: boolean;
  /** Зависимости для VLIW-планировщика (v2, опционально). */
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
