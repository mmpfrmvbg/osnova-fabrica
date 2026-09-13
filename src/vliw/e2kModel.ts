/**
 * Упрощённая модель e2k для планировщика VLIW (Этап 1.1).
 * Ширина пакета, типы слотов, маппинг опкодов байткода Основа → тип слота.
 * Задержки пока не учитываются — все операции 1 такт.
 */

/** Число слотов в одном VLIW-пакете (e2k). */
export const VLIW_SLOTS = 4;

/** Типы слотов: целочисленные (I0, I1), память (M), ветвление (B). */
export type SlotType = "I0" | "I1" | "M" | "B";

const ALU_OPS = new Set<string>([
  "add", "sub", "mul", "div", "rem",
  "eq", "ne", "lt", "le", "gt", "ge",
  "and", "or", "not",
]);
const PUSH_OPS = new Set<string>([
  "const", "const.true", "const.false", "const.null",
  "local.get", "global.get",
]);
const POP_PUSH_OPS = new Set<string>([
  "local.set", "global.set",
]);
const MEM_OPS = new Set<string>([
  "field.get", "field.set",
]);
const BRANCH_OPS = new Set<string>([
  "jmp", "jmp_if", "jmp_if_not", "call", "ret", "invoke",
]);

/**
 * Классифицирует опкод байткода Основа по типу слота e2k.
 * I0/I1 — целочисленные/логические операции и работа с локальными;
 * M — память (поля, load/store);
 * B — ветвления и вызовы.
 */
export function classifyOpcode(op: string): SlotType {
  if (BRANCH_OPS.has(op)) return "B";
  if (MEM_OPS.has(op)) return "M";
  if (ALU_OPS.has(op)) return "I0";
  if (PUSH_OPS.has(op) || POP_PUSH_OPS.has(op)) return "I1";
  if (op === "result.unwrap" || op === "result.tag") return "I0";
  return "I0";
}

/**
 * Слоты, в которые инструкция может лечь. Ветвление — только B, память — только M,
 * всё целочисленное/стековое/локальное — в любой из двух ALU-слотов I0/I1.
 * Это даёт реальный параллелизм: две независимые const/add лягут в I0 и I1.
 */
export function possibleSlots(op: string): SlotType[] {
  if (BRANCH_OPS.has(op)) return ["B"];
  if (MEM_OPS.has(op)) return ["M"];
  return ["I0", "I1"];
}
