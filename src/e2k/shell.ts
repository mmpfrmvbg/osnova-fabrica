/**
 * РЕАЛИЗАЦИЯ ИНТЕРФЕЙСА НА ВНУТРЕННЕЙ ОБОЛОЧКЕ ПРОЕКТА.
 *
 * Кодировка — `src/e2k/encoding.ts`, статус **ДОПУЩЕНИЕ**: это **не** кодировка e2k
 * (в руководстве МЦСТ бинарной кодировки нет). Здесь только переходник между
 * документированной ассемблерной формой (`AsmInstruction`) и полями оболочки.
 *
 * # Два правила переходника
 *
 * 1. **Поля оболочки наружу не протекают.** Ни код операции, ни форма, ни разрядность в
 *    интерфейсе не появляются: форма выводится из мнемоники и видов операндов, код операции —
 *    из таблицы мнемоник (`src/e2k/encoding.ts`).
 * 2. **Ничего не теряется молча.** Поля, которые интерфейс не выражает, обязаны быть
 *    нулевыми; если во входных байтах они установлены, декодирование **отвергается**. Иначе
 *    подмена бита в невыразимом поле возвращала бы ту же инструкцию — то есть кодировка
 *    имела бы невидимые различия, а оракул этого не видел бы (дефект 1, см.
 *    `src/e2k/encoding.negative.test.ts`).
 *
 * Разрядность — как раз такое поле: документ выражает её **мнемоникой** («Арифметические
 * операции имеют разные мнемоники для типов и разрядностей аргументов», стр. 20), а состав
 * семейств `PADD*` и подобных документом не раскрыт, поэтому называть варианты мы не вправе.
 * Значит, через интерфейс проходит только разрядность `WORD`; всё остальное отвергается.
 *
 * **Соответствие «список операндов ↔ поля» — наше соглашение**, документ его не задаёт
 * (`docs/e2k-backend.md` §4.3). Результат — последним операндом (стр. 19).
 */

import {
  EncodingError,
  FORMS,
  INSTRUCTION_SIZE,
  MAX_CHANNEL,
  MAX_REGISTER,
  WIDTHS,
  decode as decodeShell,
  encode as encodeShell,
  mnemonicEntry,
  type E2kInstruction,
  type OpcodeEntry,
} from "./encoding";
import type { AsmInstruction, Encoder, Operand } from "./backend";

/** Поля оболочки, которые несёт интерфейс. */
type Slot = "src1" | "src2" | "imm" | "dst";

/** Слоты по форме: результат — последним (стр. 19). */
const SLOTS: Record<number, readonly Slot[]> = {
  [FORMS.REG3]: ["src1", "src2", "dst"],
  [FORMS.REG_IMM]: ["src1", "imm", "dst"],
  [FORMS.PACKED]: ["src1", "src2", "dst"],
  [FORMS.BRANCH]: ["imm"],
  [FORMS.CALL]: ["imm", "dst"],
  [FORMS.RETURN]: [],
  [FORMS.MEMORY]: ["src1", "imm", "dst"],
};

/** Слоты формы `REG_IMM` для операций, у которых источник — только литерал. */
const REG_IMM_ONLY_SLOTS: readonly Slot[] = ["imm", "dst"];

/**
 * Операции формы «регистр и непосредственное», у которых источником служит **только**
 * литерал: результату не предшествует регистр-источник.
 *
 * Это **наше соглашение** (документ порядок операндов не задаёт); список собран по смыслу
 * мнемоник `MOV*`/`SXT` в извлечении (`docs/e2k-dsp-instructions.md`).
 */
const IMM_ONLY = new Set(["MOVAB", "MOVAH", "MOVAW", "MOVAQ", "MOVAD", "SXT"]);

function slotsFor(entry: OpcodeEntry, form: number): readonly Slot[] {
  const base =
    form === FORMS.REG_IMM && IMM_ONLY.has(entry.mnemonic) ? REG_IMM_ONLY_SLOTS : (SLOTS[form] ?? []);
  return entry.hasDst ? base : base.filter((slot) => slot !== "dst");
}

function formFor(entry: OpcodeEntry, operands: readonly Operand[]): number {
  const hasImm = operands.some((operand) => operand.kind === "imm");
  const candidates = hasImm
    ? [FORMS.REG_IMM, FORMS.PACKED, FORMS.MEMORY, FORMS.BRANCH, FORMS.CALL, FORMS.RETURN]
    : [FORMS.REG3, FORMS.PACKED, FORMS.MEMORY, FORMS.BRANCH, FORMS.CALL, FORMS.RETURN];
  for (const form of candidates) {
    if (!entry.forms.includes(form)) continue;
    if (slotsFor(entry, form).length === operands.length) return form;
  }
  throw new EncodingError(
    `не удалось выбрать форму оболочки для «${entry.mnemonic}» с ${operands.length} операндами`,
  );
}

function toShellInstruction(instruction: AsmInstruction): E2kInstruction {
  const entry = mnemonicEntry(instruction.mnemonic);
  if (entry === undefined) {
    throw new EncodingError(`мнемоники «${instruction.mnemonic}» нет в таблице оболочки`);
  }
  if (!Number.isInteger(instruction.channel) || instruction.channel < 0 || instruction.channel > MAX_CHANNEL) {
    throw new EncodingError(`канал вне диапазона 0..${MAX_CHANNEL}: ${instruction.channel}`);
  }
  const form = formFor(entry, instruction.operands);
  const slots = slotsFor(entry, form);
  let dst = 0;
  let src1 = 0;
  let src2 = 0;
  let imm = 0;
  instruction.operands.forEach((operand, index) => {
    const slot = slots[index];
    if (slot === "imm") {
      if (operand.kind !== "imm") {
        throw new EncodingError(`операнд ${index} «${entry.mnemonic}»: ожидалось непосредственное значение`);
      }
      imm = operand.value;
      return;
    }
    if (operand.kind !== "reg") {
      throw new EncodingError(`операнд ${index} «${entry.mnemonic}»: ожидался регистр`);
    }
    if (operand.index > MAX_REGISTER) {
      throw new EncodingError(`регистр вне диапазона 0..${MAX_REGISTER}: ${operand.index}`);
    }
    if (slot === "dst") dst = operand.index;
    else if (slot === "src1") src1 = operand.index;
    else src2 = operand.index;
  });
  return {
    opcode: entry.opcode,
    mnemonic: entry.mnemonic,
    form,
    channel: instruction.channel,
    dst,
    src1,
    src2,
    width: WIDTHS.WORD,
    imm,
  };
}

function requireZero(value: number, field: string, mnemonic: string): void {
  if (value !== 0) {
    throw new EncodingError(
      `«${mnemonic}»: поле ${field} = ${value}, но интерфейс его не выражает — декодирование отвергнуто, чтобы не терять поле молча`,
    );
  }
}

function toAsmInstruction(decoded: E2kInstruction): AsmInstruction {
  const entry = mnemonicEntry(decoded.mnemonic);
  if (entry === undefined) throw new EncodingError(`мнемоники «${decoded.mnemonic}» нет в таблице оболочки`);
  if (decoded.width !== WIDTHS.WORD) {
    throw new EncodingError(
      `«${decoded.mnemonic}»: разрядность ${decoded.width} интерфейсом не выражается (варианты семейств документом не раскрыты)`,
    );
  }
  const slots = slotsFor(entry, decoded.form);
  const used = new Set<Slot>(slots);
  if (!used.has("dst")) requireZero(decoded.dst ?? 0, "dst", decoded.mnemonic);
  if (!used.has("src1")) requireZero(decoded.src1 ?? 0, "src1", decoded.mnemonic);
  if (!used.has("src2")) requireZero(decoded.src2 ?? 0, "src2", decoded.mnemonic);
  if (!used.has("imm")) requireZero(decoded.imm ?? 0, "imm", decoded.mnemonic);

  const operands: Operand[] = slots.map((slot) => {
    if (slot === "imm") return { kind: "imm", value: decoded.imm ?? 0 };
    const index = slot === "dst" ? (decoded.dst ?? 0) : slot === "src1" ? (decoded.src1 ?? 0) : (decoded.src2 ?? 0);
    return { kind: "reg", index };
  });
  return { mnemonic: decoded.mnemonic, channel: decoded.channel, operands };
}

/** Паспорт оболочки: статус назван прямо, размер заявлен, ограничение сформулировано. */
export const SHELL_DESCRIPTION = {
  id: "internal-shell",
  title: "Внутренняя оболочка проекта (не e2k)",
  status: "ДОПУЩЕНИЕ",
  instructionSize: INSTRUCTION_SIZE,
  source:
    "docs/e2k-encoding.md §2.1 — ДОПУЩЕНИЕ; кодировки e2k в руководстве МЦСТ нет (docs/e2k-encoding-raw.md §1.7)",
  limitation:
    "код на этой оболочке нельзя выдать на реальный e2k: соответствие битов железу не проверено и не известно; разрядность выражается не интерфейсом, а мнемоникой, поэтому через интерфейс проходит только WORD",
} as const;

/** Создать реализацию на внутренней оболочке. */
export function createShellEncoder(): Encoder {
  return {
    description: SHELL_DESCRIPTION,
    encode(instruction: AsmInstruction): Uint8Array {
      return encodeShell(toShellInstruction(instruction));
    },
    decode(bytes: Uint8Array): AsmInstruction {
      return toAsmInstruction(decodeShell(bytes));
    },
  };
}
