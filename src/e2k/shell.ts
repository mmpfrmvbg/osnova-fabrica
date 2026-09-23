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

// ─────────────────────────────────────────────────────────────────────────────
// НОСИТЕЛИ IR: НАШИ ИМЕНА, НЕ МНЕМОНИКИ e2k
//
// Оболочка несёт два пространства имён. Первое — документированные мнемоники e2k
// (`OPCODES` в `src/e2k/encoding.ts`), скопированные из извлечения посимвольно. Второе —
// **носители IR**: имена вида `IR.*`, которых в руководстве нет и быть не может. Они введены
// потому, что операции регистрового IR **не соответствуют** документированным операциям:
// пул констант (`const`), имя хост-вызова (`invoke`), абсолютный адрес перехода, дробное
// деление (`/` в языке — вещественное, а документированное целочисленное деление
// `SDIVs/x` не кодируется вовсе).
//
// Правило проекта «мнемоника либо скопирована посимвольно, либо её нет в спецификации»
// соблюдается так: носители **помечены префиксом** и живут отдельно; ни один носитель не
// совпадает с документированной мнемоникой, и это проверяет оракул
// (`src/e2k/emitterOracle.ts`).
// ─────────────────────────────────────────────────────────────────────────────

/** Префикс имён носителей IR — признак того, что имя наше, а не из руководства. */
export const IR_CARRIER_PREFIX = "IR.";

/** Коды носителей IR. Диапазон 0x80… выбран вне таблицы документированных операций. */
export const IR_CARRIERS: Readonly<Record<string, number>> = {
  "IR.const": 0x80,
  "IR.move": 0x81,
  "IR.add": 0x82,
  "IR.sub": 0x83,
  "IR.mul": 0x84,
  "IR.div": 0x85,
  // БЛОК 2: целочисленное деление языка — свой носитель (0x96 — свободный код
  // вне документированной таблицы). Отдельный от `IR.div`, потому что семантика
  // другая: `IR.div` вещественный и остаётся отказом, `IR.idiv` понижается в `sdivs`.
  "IR.idiv": 0x96,
  "IR.rem": 0x86,
  "IR.eq": 0x87,
  "IR.ne": 0x88,
  "IR.lt": 0x89,
  "IR.le": 0x8a,
  "IR.gt": 0x8b,
  "IR.ge": 0x95,
  "IR.and": 0x8c,
  "IR.or": 0x8d,
  "IR.not": 0x8e,
  "IR.jmp": 0x8f,
  "IR.jmp_if": 0x90,
  "IR.jmp_if_not": 0x91,
  "IR.call": 0x92,
  "IR.invoke": 0x93,
  "IR.ret": 0x94,
};

/** Поля носителя, которые несёт инструкция оболочки. */
type CarrierSlot = "dst" | "src1" | "src2" | "flags" | "imm";

/**
 * Список полей каждого носителя — **фиксированный и позиционный**.
 *
 * Фиксированный, потому что список операндов позиционный: необязательное поле в середине
 * сделало бы разбор неоднозначным. Поэтому присутствие значения выражается флагом
 * (`IR.ret`: есть ли возвращаемое значение; `IR.call`/`IR.invoke`: есть ли результат и
 * сколько аргументов), а не пропуском поля.
 */
const CARRIER_SLOTS: Readonly<Record<string, readonly CarrierSlot[]>> = {
  "IR.const": ["dst", "imm", "flags"],
  "IR.move": ["dst", "src1"],
  "IR.add": ["dst", "src1", "src2"],
  "IR.sub": ["dst", "src1", "src2"],
  "IR.mul": ["dst", "src1", "src2"],
  "IR.div": ["dst", "src1", "src2"],
  "IR.idiv": ["dst", "src1", "src2"],
  "IR.rem": ["dst", "src1", "src2"],
  "IR.eq": ["dst", "src1", "src2"],
  "IR.ne": ["dst", "src1", "src2"],
  "IR.lt": ["dst", "src1", "src2"],
  "IR.le": ["dst", "src1", "src2"],
  "IR.gt": ["dst", "src1", "src2"],
  "IR.ge": ["dst", "src1", "src2"],
  "IR.and": ["dst", "src1", "src2"],
  "IR.or": ["dst", "src1", "src2"],
  "IR.not": ["dst", "src1"],
  "IR.jmp": ["imm"],
  "IR.jmp_if": ["src1", "imm"],
  "IR.jmp_if_not": ["src1", "imm"],
  "IR.call": ["flags", "src1", "src2", "imm", "dst"],
  "IR.invoke": ["flags", "src1", "src2", "imm", "dst"],
  "IR.ret": ["flags", "src1"],
};

/** Предел поля `flags` по носителю: тип константы, признаки и число аргументов. */
const CARRIER_FLAG_LIMIT: Readonly<Record<string, number>> = {
  "IR.const": 4, // 0=i32, 1=f64, 2=str, 3=bool, 4=null
  "IR.call": 7, // бит 0 — есть результат, биты 1–2 — argc
  "IR.invoke": 7,
  "IR.ret": 1, // бит 0 — есть возвращаемое значение
};

/** Имя носителя по коду операции оболочки (обратный разбор байтов). */
function carrierByOpcode(opcode: number): string | undefined {
  return Object.keys(IR_CARRIERS).find((name) => IR_CARRIERS[name] === opcode);
}

/** Поля носителя по имени; `undefined` — это не носитель. */
export function carrierSlots(mnemonic: string): readonly CarrierSlot[] | undefined {
  return CARRIER_SLOTS[mnemonic];
}

/** Закодировать инструкцию-носитель IR в 10 байт оболочки. */
function encodeCarrier(instruction: AsmInstruction): Uint8Array {
  const slots = CARRIER_SLOTS[instruction.mnemonic]!;
  const limit = CARRIER_FLAG_LIMIT[instruction.mnemonic] ?? 0;
  let dst = 0;
  let src1 = 0;
  let src2 = 0;
  let flags = 0;
  let imm = 0;
  instruction.operands.forEach((operand, index) => {
    const slot = slots[index];
    if (slot === undefined) {
      throw new EncodingError(
        `носитель «${instruction.mnemonic}»: лишний операнд ${index} (полей ${slots.length})`,
      );
    }
    if (slot === "flags" || slot === "imm") {
      if (operand.kind !== "imm") {
        throw new EncodingError(`носитель «${instruction.mnemonic}»: поле ${slot} ожидает число`);
      }
      if (slot === "flags") {
        if (!Number.isInteger(operand.value) || operand.value < 0 || operand.value > limit) {
          throw new EncodingError(
            `носитель «${instruction.mnemonic}»: флаги вне диапазона 0..${limit}: ${operand.value}`,
          );
        }
        flags = operand.value;
      } else {
        if (!Number.isInteger(operand.value) || operand.value < -0x80000000 || operand.value > 0x7fffffff) {
          throw new EncodingError(`носитель «${instruction.mnemonic}»: imm вне диапазона int32`);
        }
        imm = operand.value;
      }
      return;
    }
    if (operand.kind !== "reg") {
      throw new EncodingError(`носитель «${instruction.mnemonic}»: поле ${slot} ожидает регистр`);
    }
    if (operand.index > MAX_REGISTER) {
      throw new EncodingError(`регистр вне диапазона 0..${MAX_REGISTER}: ${operand.index}`);
    }
    if (slot === "dst") dst = operand.index;
    else if (slot === "src1") src1 = operand.index;
    else src2 = operand.index;
  });
  if (instruction.operands.length !== slots.length) {
    throw new EncodingError(
      `носитель «${instruction.mnemonic}»: полей ${instruction.operands.length}, ожидалось ${slots.length}`,
    );
  }
  if (!Number.isInteger(instruction.channel) || instruction.channel < 0 || instruction.channel > MAX_CHANNEL) {
    throw new EncodingError(`канал вне диапазона 0..${MAX_CHANNEL}: ${instruction.channel}`);
  }

  const bytes = new Uint8Array(INSTRUCTION_SIZE);
  bytes[0] = IR_CARRIERS[instruction.mnemonic]!;
  bytes[1] = (instruction.channel & 0x1f) << 3;
  bytes[2] = dst & 0x3f;
  bytes[3] = src1 & 0x3f;
  bytes[4] = src2 & 0x3f;
  bytes[5] = flags;
  bytes[6] = imm & 0xff;
  bytes[7] = (imm >>> 8) & 0xff;
  bytes[8] = (imm >>> 16) & 0xff;
  bytes[9] = (imm >>> 24) & 0xff;
  return bytes;
}

/** Разобрать инструкцию-носитель IR из байтов оболочки. */
function decodeCarrier(bytes: Uint8Array): AsmInstruction {
  const mnemonic = carrierByOpcode(bytes[0]!);
  if (mnemonic === undefined) throw new EncodingError(`неизвестный носитель: ${bytes[0]}`);
  const slots = CARRIER_SLOTS[mnemonic]!;
  const channel = (bytes[1]! >> 3) & 0x1f;
  if ((bytes[1]! & 0x07) !== 0) throw new EncodingError("резервные биты установлены в поле формы");
  if (channel > MAX_CHANNEL) throw new EncodingError(`номер канала вне диапазона 0..${MAX_CHANNEL}: ${channel}`);
  for (const [name, index] of [["dst", 2], ["src1", 3], ["src2", 4]] as const) {
    if ((bytes[index]! & 0xc0) !== 0) throw new EncodingError(`резервные биты установлены в поле ${name}`);
  }
  const limit = CARRIER_FLAG_LIMIT[mnemonic] ?? 0;
  if (bytes[5]! > limit) {
    throw new EncodingError(
      `носитель «${mnemonic}»: флаги ${bytes[5]} вне диапазона 0..${limit}`,
    );
  }
  const imm = (bytes[6]! | (bytes[7]! << 8) | (bytes[8]! << 16) | (bytes[9]! << 24)) | 0;

  // «Не терять поле молча»: поле, которого нет в шаблоне носителя, обязано быть нулевым.
  // Иначе подмена бита в нём декодировалась бы в ту же инструкцию, и второй уровень контроля
  // (инъективность отображения) ослеп бы — ровно тот дефект, что найден на таблице e2k.
  const used = new Set<CarrierSlot>(slots);
  for (const [name, index, mask] of [
    ["dst", 2, 0x3f],
    ["src1", 3, 0x3f],
    ["src2", 4, 0x3f],
  ] as const) {
    if (!used.has(name) && (bytes[index]! & mask) !== 0) {
      throw new EncodingError(
        `носитель «${mnemonic}»: поле ${name} = ${bytes[index]! & mask}, но шаблон его не несёт — декодирование отвергнуто`,
      );
    }
  }
  if (!used.has("flags") && bytes[5]! !== 0) {
    throw new EncodingError(
      `носитель «${mnemonic}»: поле flags = ${bytes[5]!}, но шаблон его не несёт — декодирование отвергнуто`,
    );
  }
  if (!used.has("imm") && imm !== 0) {
    throw new EncodingError(
      `носитель «${mnemonic}»: поле imm = ${imm}, но шаблон его не несёт — декодирование отвергнуто`,
    );
  }

  const operands: Operand[] = slots.map((slot) => {
    if (slot === "flags") return { kind: "imm", value: bytes[5]! };
    if (slot === "imm") return { kind: "imm", value: imm };
    if (slot === "dst") return { kind: "reg", index: bytes[2]! & 0x3f };
    if (slot === "src1") return { kind: "reg", index: bytes[3]! & 0x3f };
    return { kind: "reg", index: bytes[4]! & 0x3f };
  });
  return { mnemonic, channel, operands };
}

/** Задокументированная операция e2k это или носитель IR. */
export function isIrCarrier(mnemonic: string): boolean {
  return Object.prototype.hasOwnProperty.call(IR_CARRIERS, mnemonic);
}

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
    "код на этой оболочке нельзя выдать на реальный e2k: соответствие битов железу не проверено и не известно; разрядность выражается не интерфейсом, а мнемоникой, поэтому через интерфейс проходит только WORD; кроме документированных мнемоник оболочка несёт НАШИ носители IR (префикс «IR.») — это не мнемоники e2k, и реальный бэкенд их не примет",
} as const;

/** Создать реализацию на внутренней оболочке. */
export function createShellEncoder(): Encoder {
  return {
    description: SHELL_DESCRIPTION,
    encode(instruction: AsmInstruction): Uint8Array {
      if (isIrCarrier(instruction.mnemonic)) return encodeCarrier(instruction);
      return encodeShell(toShellInstruction(instruction));
    },
    decode(bytes: Uint8Array): AsmInstruction {
      if (bytes.length === INSTRUCTION_SIZE && carrierByOpcode(bytes[0]!) !== undefined) {
        return decodeCarrier(bytes);
      }
      return toAsmInstruction(decodeShell(bytes));
    },
  };
}
