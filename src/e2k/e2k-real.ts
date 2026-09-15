/**
 * РЕАЛЬНАЯ КОДИРОВКА e2k — ИЗВЛЕЧЕНА ИЗ ОТКРЫТЫХ ИСТОЧНИКОВ.
 *
 * # Что здесь
 *
 * Второй бэкенд слоя замены: `getEncoder("e2k")`. Кодирует **документированные операции e2k**
 * (те, что есть в таблице опкодов МЦСТ) в байты реальной кодировки и разбирает их обратно.
 *
 * Мнемоники — **копии из таблицы МЦСТ посимвольно**: `adds`, `subs`, `muls`, `movts`, …
 * (в таблице МЦСТ они записаны в нижнем регистре, в руководстве — в верхнем). Мнемоник оболочки
 * (`ADDs/d`, `PADD*`, `IR.*`) этот бэкенд **не знает и знать не должен**: у оболочки своё
 * пространство имён, и смешивать их значило бы выдавать одно за другое.
 *
 * # Источники (совпадающие описания)
 *
 * | что | источник |
 * |---|---|
 * | таблица опкодов: имя → код операции, формат, допустимые каналы | `opcodes/e2k-opc.h` (копия — `docs/e2k-opcodes-real.md`) |
 * | слог ALS: `spec[31]`, `cop[30:24]`, `src1[23:16]`, `src2[15:8]`, `dst[7:0]` | `opcodes/e2k-dis.c:828,412,449,573`; `qemu/target/e2k/syllab-format.h:32-41`; `E2KInstrFormats.td:475-478`; `elbrus-docs README.md:284-288` |
 * | слог ALF2: `opce[23:16]` | `qemu/target/e2k/syllab-format.h:43-45`; `opcodes/e2k-dis.c:867` |
 * | полуслог ALES: `opc2[15:8]`, `opce[7:0]` | `qemu/target/e2k/syllab-format.h:85-91`; `opcodes/e2k-dis.c:930-932` |
 * | значения `EXT = 0x1`, `NONE = 0xc0` | `include/opcode/e2k.h:68,93`; `qemu/target/e2k/opcode-tables.h:15,41` |
 * | HS: `mdl[3:0]`, `lng[6:4]`, `al[31:26]` (ALS0…ALS5), `ale[25:20]` (ALES0…ALES5) | `qemu/target/e2k/syllab-format.h:17-29`; `gas/config/tc-e2k.c:8921-8934`; `elbrus-docs README.md:172-198` |
 * | длина команды: `(lng+1)*8` байт; «средняя точка» `mdl` | `qemu/target/e2k/instr-bits.h:41-45`; `gas/config/tc-e2k.c:9366,9577` |
 * | порядок полуслогов ALES0/1/3/4: первый — в **старшей** половине слова | `gas/config/tc-e2k.c:9392-9399`; `qemu/target/e2k/instr-bits.h:127-148` |
 * | регистр `%rN` кодируется значением `N` | `E2KRegisterInfo.td:23-25` (`HWEncoding = Enc`) |
 *
 * Сырые данные и их хеши — `docs/e2k-sources-raw.md`; соответствие «подмножество DSP ↔ источник» —
 * `docs/e2k-opcodes-real.md`.
 *
 * # Чего здесь НЕТ и почему
 *
 * 1. **Не весь e2k.** Реализованы только короткая (ALF1/ALF2 — слог ALS) и длинная
 *    (ALOPF11 — слог ALS + полуслог ALES) формы, по одной операции на команду. Команда с
 *    несколькими слогами, SS-слогом, CS-слогом, литералами, предикатами, MAS — **не
 *    реализована** и отвергается с названной причиной, а не кодируется наугад.
 * 2. **Не выдумано.** Мнемоники, которых нет в таблице опкодов, отвергаются
 *    `EncodingRefusedError` с текстом «НЕТ В ИСТОЧНИКЕ».
 * 3. **Не проверено инструментом.** Ни MCST-objdump, ни QEMU-e2k в этом окружении не собраны
 *    (`docs/e2k-qemu-build.md` §2), поэтому байты сверены с **исходниками** четырёх описаний,
 *    а не прогнаны через дизассемблер. Round-trip (`encode` → `decode`) проверяет
 *    согласованность **этой** реализации, а не соответствие железу.
 *
 * # Переменная длина и шлюз
 *
 * Инструкция e2k — 8 или 16 байт (кратна 8: `qemu/target/e2k/instr-bits.h:41-45`). Поле
 * `instructionSize` интерфейса — **одно число**, поэтому в паспорте стоит 8 (короткая форма),
 * а длинная форма описана в `limitation` и в {@link REAL_LONG_FORM_SIZE}. Шлюз `auditEncoder`
 * рассчитан на одну длину и проверяет короткую форму; длинная проверяется отдельным оракулом.
 */

import {
  EncodingRefusedError,
  type AsmInstruction,
  type Encoder,
  type EncoderDescription,
  type Operand,
} from "./backend";
import { EncodingError } from "./encoding";

// ─────────────────────────────────────────────────────────────────────────────
// РАЗМЕРЫ И ПОЛЯ
// ─────────────────────────────────────────────────────────────────────────────

/** Размер короткой формы (слог ALS без ALES) в байтах. */
export const REAL_SHORT_FORM_SIZE = 8;

/** Размер длинной формы (слог ALS + полуслог ALES) в байтах. */
export const REAL_LONG_FORM_SIZE = 16;

/** Размеры, которые принимает разбор. Третьего размера в этой реализации нет. */
export const REAL_INSTRUCTION_SIZES: readonly number[] = [REAL_SHORT_FORM_SIZE, REAL_LONG_FORM_SIZE];

/** Число ALU-каналов: `allowed_channels[6]` в таблице МЦСТ, `ALS_CHANNELS_NUMBER` в binutils. */
export const REAL_CHANNELS = 6;

/** Максимальный регистр в поле слога: `%r0`…`%r63` (`E2KRegisterInfo.td:23-25`). */
export const REAL_MAX_REGISTER = 63;

/** Поля заголовочного слога (HS) — `qemu/target/e2k/syllab-format.h:17-29`. */
const HS = {
  /** `mdl[3:0]` — «средняя точка»: число 4-байтовых слогов до неё минус один. */
  mdl: { shift: 0, mask: 0xf },
  /** `lng[6:4]` — длина команды в восьмибайтовых словах минус один. */
  lng: { shift: 4, mask: 0x7 },
  /** `nop[9:7]` — число nop; в этой реализации ноль. */
  nop: { shift: 7, mask: 0x7 },
  /** `lm` — режим цикла; в этой реализации ноль. */
  lm: { shift: 10, mask: 0x1 },
  /**
   * Бит 11. В `qemu/target/e2k/syllab-format.h:17-29` не назван, в `gas/config/tc-e2k.c:8926`
   * это поле `x`. Интерфейс его не выражает, поэтому здесь он обязан быть нулевым.
   */
  x: { shift: 11, mask: 0x1 },
  /** `s` — наличие SS-слога; в этой реализации ноль. */
  ss: { shift: 12, mask: 0x1 },
  /** `sw` — в этой реализации ноль. */
  sw: { shift: 13, mask: 0x1 },
  /** `c[1:0]` — наличие CS0/CS1; в этой реализации ноль. */
  cs: { shift: 14, mask: 0x3 },
  /** `cd[1:0]` — число CDS-слогов; здесь ноль. */
  cd: { shift: 16, mask: 0x3 },
  /** `pl[1:0]` — число PLS-слогов; здесь ноль. */
  pl: { shift: 18, mask: 0x3 },
  /** `ale[5:0]` — наличие ALES0…ALES5. */
  ale: { shift: 20, mask: 0x3f },
  /** `al[5:0]` — наличие ALS0…ALS5. */
  al: { shift: 26, mask: 0x3f },
  /** Бит 31 слога ALS — спекулятивный режим; интерфейс его не выражает, здесь всегда ноль. */
  speculative: 31,
} as const;

/** Код расширения ALES: `EXT = 0x1` (`include/opcode/e2k.h:68`). */
const ALES_OPC2_EXT = 0x01;

/** Код расширения ALES: `NONE = 0xc0` (`include/opcode/e2k.h:93`). */
const ALES_OPCE_NONE = 0xc0;

/** Полуслог ALES длинной формы: `(opc2 << 8) | opce`. */
const ALES_WORD = (ALES_OPC2_EXT << 8) | ALES_OPCE_NONE;

/** Источник значения полуслога ALES — для паспорта и оракула. */
export const ALES_WORD_SOURCE =
  "include/opcode/e2k.h:68 (EXT = 0x1), include/opcode/e2k.h:93 (NONE = 0xc0); " +
  "qemu/target/e2k/opcode-tables.h:15,41";

// ─────────────────────────────────────────────────────────────────────────────
// ТАБЛИЦА
// ─────────────────────────────────────────────────────────────────────────────

/** Формы, которые эта реализация кодирует. */
export type RealForm = "ALF1" | "ALF2" | "ALF11";

/** Слот операнда в слоге. Порядок в `operands` — порядок операндов интерфейса (результат последним). */
export type RealSlot = "src1" | "src2" | "dst";

/** Запись таблицы: операция e2k, её код и форма. */
export interface RealOpcodeEntry {
  /** Мнемоника — копия из `opcodes/e2k-opc.h` посимвольно. */
  readonly mnemonic: string;
  /** 7-битный код операции (биты 30:24 слога ALS). */
  readonly opc: number;
  /** Форма слога. */
  readonly form: RealForm;
  /** Операнды интерфейса в порядке `формат МЦСТ`: аргументы, затем результат. */
  readonly operands: readonly RealSlot[];
  /** Допустимые индексы слога ALS (из `allowed_channels` таблицы МЦСТ). */
  readonly channels: readonly number[];
  /** Источник: файл:строка таблицы опкодов. */
  readonly source: string;
  /** Источник раскладки полей формы. */
  readonly formSource: string;
}

const ALF1_SOURCE = "qemu/target/e2k/syllab-format.h:39-41 (ALF1: dst[7:0], src2[15:8], src1[23:16])";
const ALF2_SOURCE = "qemu/target/e2k/syllab-format.h:43-45 (ALF2: dst[7:0], src2[15:8], opce[23:16])";
const ALF11_SOURCE = "qemu/target/e2k/syllab-format.h:85-91 (ALEF: opc2[15:8], opce[7:0])";

/** Все каналы: `{1, 1, 1, 1, 1, 1}` в таблице МЦСТ. */
const ALL_CHANNELS: readonly number[] = [0, 1, 2, 3, 4, 5];
/** Каналы длинной формы этих операций: `{1, 1, 0, 1, 1, 0}` в таблице МЦСТ — без 2 и 5. */
const LONG_CHANNELS: readonly number[] = [0, 1, 3, 4];

/**
 * Таблица кодируемых операций.
 *
 * Каждая строка — **цитата** из `opcodes/e2k-opc.h`: имя, код операции и допустимые каналы
 * совпадают с записью источника. Состав ограничен подмножеством DSP
 * (`docs/e2k-opcodes-real.md`), потому что именно оно нужно сквозному прогону пяти ядер.
 */
export const REAL_OPCODES: readonly RealOpcodeEntry[] = [
  // ALF1 — слог ALS, операнды src1, src2, dst
  { mnemonic: "ands", opc: 0x00, form: "ALF1", operands: ["src1", "src2", "dst"], channels: ALL_CHANNELS, source: "opcodes/e2k-opc.h:79", formSource: ALF1_SOURCE },
  { mnemonic: "andd", opc: 0x01, form: "ALF1", operands: ["src1", "src2", "dst"], channels: ALL_CHANNELS, source: "opcodes/e2k-opc.h:84", formSource: ALF1_SOURCE },
  { mnemonic: "ors", opc: 0x04, form: "ALF1", operands: ["src1", "src2", "dst"], channels: ALL_CHANNELS, source: "opcodes/e2k-opc.h:99", formSource: ALF1_SOURCE },
  { mnemonic: "ord", opc: 0x05, form: "ALF1", operands: ["src1", "src2", "dst"], channels: ALL_CHANNELS, source: "opcodes/e2k-opc.h:104", formSource: ALF1_SOURCE },
  { mnemonic: "xors", opc: 0x08, form: "ALF1", operands: ["src1", "src2", "dst"], channels: ALL_CHANNELS, source: "opcodes/e2k-opc.h:119", formSource: ALF1_SOURCE },
  { mnemonic: "xord", opc: 0x09, form: "ALF1", operands: ["src1", "src2", "dst"], channels: ALL_CHANNELS, source: "opcodes/e2k-opc.h:124", formSource: ALF1_SOURCE },
  { mnemonic: "sxt", opc: 0x0c, form: "ALF1", operands: ["src1", "src2", "dst"], channels: ALL_CHANNELS, source: "opcodes/e2k-opc.h:199", formSource: ALF1_SOURCE },
  { mnemonic: "adds", opc: 0x10, form: "ALF1", operands: ["src1", "src2", "dst"], channels: ALL_CHANNELS, source: "opcodes/e2k-opc.h:19", formSource: ALF1_SOURCE },
  { mnemonic: "addd", opc: 0x11, form: "ALF1", operands: ["src1", "src2", "dst"], channels: ALL_CHANNELS, source: "opcodes/e2k-opc.h:24", formSource: ALF1_SOURCE },
  { mnemonic: "subs", opc: 0x12, form: "ALF1", operands: ["src1", "src2", "dst"], channels: ALL_CHANNELS, source: "opcodes/e2k-opc.h:29", formSource: ALF1_SOURCE },
  { mnemonic: "subd", opc: 0x13, form: "ALF1", operands: ["src1", "src2", "dst"], channels: ALL_CHANNELS, source: "opcodes/e2k-opc.h:34", formSource: ALF1_SOURCE },
  { mnemonic: "scls", opc: 0x14, form: "ALF1", operands: ["src1", "src2", "dst"], channels: ALL_CHANNELS, source: "opcodes/e2k-opc.h:159", formSource: ALF1_SOURCE },
  { mnemonic: "scld", opc: 0x15, form: "ALF1", operands: ["src1", "src2", "dst"], channels: ALL_CHANNELS, source: "opcodes/e2k-opc.h:164", formSource: ALF1_SOURCE },
  { mnemonic: "shls", opc: 0x18, form: "ALF1", operands: ["src1", "src2", "dst"], channels: ALL_CHANNELS, source: "opcodes/e2k-opc.h:139", formSource: ALF1_SOURCE },
  { mnemonic: "shrs", opc: 0x1a, form: "ALF1", operands: ["src1", "src2", "dst"], channels: ALL_CHANNELS, source: "opcodes/e2k-opc.h:149", formSource: ALF1_SOURCE },
  { mnemonic: "sars", opc: 0x1c, form: "ALF1", operands: ["src1", "src2", "dst"], channels: ALL_CHANNELS, source: "opcodes/e2k-opc.h:179", formSource: ALF1_SOURCE },
  // ALF2 — слог ALS, расширение в битах 23:16, операнды src2, dst
  { mnemonic: "movts", opc: 0x60, form: "ALF2", operands: ["src2", "dst"], channels: ALL_CHANNELS, source: "opcodes/e2k-opc.h:644", formSource: ALF2_SOURCE },
  { mnemonic: "movtd", opc: 0x61, form: "ALF2", operands: ["src2", "dst"], channels: ALL_CHANNELS, source: "opcodes/e2k-opc.h:664", formSource: ALF2_SOURCE },
  // ALOPF11 — слог ALS + полуслог ALES
  { mnemonic: "muls", opc: 0x20, form: "ALF11", operands: ["src1", "src2", "dst"], channels: LONG_CHANNELS, source: "opcodes/e2k-opc.h:1434", formSource: ALF11_SOURCE },
  { mnemonic: "muld", opc: 0x21, form: "ALF11", operands: ["src1", "src2", "dst"], channels: LONG_CHANNELS, source: "opcodes/e2k-opc.h:1439", formSource: ALF11_SOURCE },
  { mnemonic: "umulx", opc: 0x22, form: "ALF11", operands: ["src1", "src2", "dst"], channels: LONG_CHANNELS, source: "opcodes/e2k-opc.h:1444", formSource: ALF11_SOURCE },
  { mnemonic: "smulx", opc: 0x23, form: "ALF11", operands: ["src1", "src2", "dst"], channels: LONG_CHANNELS, source: "opcodes/e2k-opc.h:1449", formSource: ALF11_SOURCE },
  { mnemonic: "umulhd", opc: 0x70, form: "ALF11", operands: ["src1", "src2", "dst"], channels: LONG_CHANNELS, source: "opcodes/e2k-opc.h:3169", formSource: ALF11_SOURCE },
  { mnemonic: "smulhd", opc: 0x71, form: "ALF11", operands: ["src1", "src2", "dst"], channels: LONG_CHANNELS, source: "opcodes/e2k-opc.h:3174", formSource: ALF11_SOURCE },
];

/** Таблица по мнемонике. */
const BY_MNEMONIC: ReadonlyMap<string, RealOpcodeEntry> = new Map(
  REAL_OPCODES.map((entry) => [entry.mnemonic, entry]),
);

/** Запись таблицы по мнемонике; `undefined` — операции нет в источнике. */
export function realOpcode(mnemonic: string): RealOpcodeEntry | undefined {
  return BY_MNEMONIC.get(mnemonic);
}

/** Причина отказа: операции нет в таблице опкодов. */
export function realRefusalReason(mnemonic: string): string {
  return (
    `НЕТ В ИСТОЧНИКЕ: мнемоники «${mnemonic}» нет в таблице опкодов МЦСТ ` +
    "(opcodes/e2k-opc.h) и нет в реализованных формах (ALF1, ALF2, ALES/ALOPF11); " +
    "см. docs/e2k-opcodes-real.md — там перечислено, что в источнике есть"
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// ПАСПОРТ
// ─────────────────────────────────────────────────────────────────────────────

/** Паспорт реализации. */
export const REAL_E2K_DESCRIPTION: EncoderDescription = {
  id: "e2k",
  title: "Кодировка e2k из открытых источников (binutils МЦСТ, LLVM-порт, QEMU МЦСТ, elbrus-docs)",
  status: "ФАКТ",
  instructionSize: REAL_SHORT_FORM_SIZE,
  source:
    "opcodes/e2k-opc.h (опкоды), opcodes/e2k-dis.c:828,412,449,573 + qemu/target/e2k/syllab-format.h:32-45,85-91 " +
    "(раскладка полей), gas/config/tc-e2k.c:8921-8934,9366,9392-9399 + qemu/target/e2k/instr-bits.h:41-45,127-148 " +
    "(заголовочный слог и длина); сырые данные — docs/e2k-sources-raw.md, извлечение — docs/e2k-opcodes-real.md",
  limitation:
    "реализованы две формы: короткая (слог ALS, 8 байт) и длинная (слог ALS + полуслог ALES, 16 байт), " +
    "по одной операции на команду; операции без слога ALS (AAS-адресация MOVAB…MOVAQ, управление ct/call/return, " +
    "SS/CS/CDS/PLS/LTS-слоги) НЕ реализованы и отвергаются; поле instructionSize заявляет короткую форму — " +
    "длинная форма занимает 16 байт (REAL_LONG_FORM_SIZE), шлюз auditEncoder рассчитан на одну длину; " +
    "байты не сверены с MCST-objdump или QEMU: в окружении нет компилятора C (docs/e2k-qemu-build.md §2)",
};

// ─────────────────────────────────────────────────────────────────────────────
// КОДИРОВАНИЕ
// ─────────────────────────────────────────────────────────────────────────────

function registerField(operand: Operand | undefined, slot: RealSlot, mnemonic: string): number {
  if (operand === undefined || operand.kind !== "reg") {
    throw new EncodingError(`«${mnemonic}»: операнд ${slot} обязан быть регистром`);
  }
  if (!Number.isInteger(operand.index) || operand.index < 0 || operand.index > REAL_MAX_REGISTER) {
    throw new EncodingError(
      `«${mnemonic}»: регистр ${String(operand.index)} не выражается полем слога (0..${REAL_MAX_REGISTER})`,
    );
  }
  return operand.index;
}

/** Проверить канал и вернуть индекс слога ALS. */
function channelOf(entry: RealOpcodeEntry, channel: number): number {
  if (!Number.isInteger(channel) || channel < 0 || channel >= REAL_CHANNELS) {
    throw new EncodingError(
      `«${entry.mnemonic}»: канал ${String(channel)} — вне ALU-каналов 0..${REAL_CHANNELS - 1}: ` +
        "слогов ALS шесть (allowed_channels[6] в opcodes/e2k-opc.h), каналы 6..23 руководства — не ALU-слоги",
    );
  }
  if (!entry.channels.includes(channel)) {
    throw new EncodingError(
      `«${entry.mnemonic}»: канал ${channel} запрещён источником (разрешены ${entry.channels.join(", ")}; ` +
        `allowed_channels в ${entry.source})`,
    );
  }
  return channel;
}

/** Разложить операнды интерфейса по полям слога ALS. */
function fieldsOf(entry: RealOpcodeEntry, operands: readonly Operand[]): { src1: number; src2: number; dst: number } {
  if (operands.length !== entry.operands.length) {
    throw new EncodingError(
      `«${entry.mnemonic}»: операндов ${operands.length}, форма ${entry.form} несёт ${entry.operands.length} ` +
        `(${entry.operands.join(", ")})`,
    );
  }
  let src1 = 0;
  let src2 = 0;
  let dst = 0;
  entry.operands.forEach((slot, index) => {
    const value = registerField(operands[index], slot, entry.mnemonic);
    if (slot === "src1") src1 = value;
    else if (slot === "src2") src2 = value;
    else dst = value;
  });
  if (entry.form === "ALF2") {
    // У ALF2 на месте src1 лежит расширение opce: операнда src1 у операции нет.
    src1 = ALES_OPCE_NONE;
  }
  return { src1, src2, dst };
}

/** Слово слога ALS (4 байта, little-endian) — раскладка ALF1/ALF2. */
function alsWord(entry: RealOpcodeEntry, fields: { src1: number; src2: number; dst: number }): number {
  return (
    ((entry.opc & 0x7f) << 24) | ((fields.src1 & 0xff) << 16) | ((fields.src2 & 0xff) << 8) | (fields.dst & 0xff)
  );
}

/** Заголовочный слог (HS). */
function headerWord(entry: RealOpcodeEntry, channel: number, long: boolean): number {
  const mdl = 1; // HS + ALS = два 4-байтовых слога до «средней точки» (gas/config/tc-e2k.c:9366)
  const words = long ? REAL_LONG_FORM_SIZE / 4 : REAL_SHORT_FORM_SIZE / 4;
  const lng = words / 2 - 1; // gas/config/tc-e2k.c:9577
  let hs = ((lng & HS.lng.mask) << HS.lng.shift) | ((mdl & HS.mdl.mask) << HS.mdl.shift);
  hs |= (1 << channel) << HS.al.shift;
  if (long) hs |= (1 << channel) << HS.ale.shift;
  return hs >>> 0;
}

function writeWord(target: Uint8Array, offset: number, word: number): void {
  target[offset] = word & 0xff;
  target[offset + 1] = (word >>> 8) & 0xff;
  target[offset + 2] = (word >>> 16) & 0xff;
  target[offset + 3] = (word >>> 24) & 0xff;
}

function writeHalf(target: Uint8Array, offset: number, half: number): void {
  target[offset] = half & 0xff;
  target[offset + 1] = (half >>> 8) & 0xff;
}

function encodeReal(instruction: AsmInstruction): Uint8Array {
  const entry = BY_MNEMONIC.get(instruction.mnemonic);
  if (entry === undefined) throw new EncodingRefusedError(realRefusalReason(instruction.mnemonic));
  const channel = channelOf(entry, instruction.channel);
  const fields = fieldsOf(entry, instruction.operands);
  const long = entry.form === "ALF11";
  const size = long ? REAL_LONG_FORM_SIZE : REAL_SHORT_FORM_SIZE;
  const bytes = new Uint8Array(size);
  writeWord(bytes, 0, headerWord(entry, channel, long));
  writeWord(bytes, 4, alsWord(entry, fields));
  if (long) {
    // Полуслог ALES0/1/3/4: первый занимает **старшую** половину слова —
    // gas/config/tc-e2k.c:9392-9399, qemu/target/e2k/instr-bits.h:137-146.
    // Слово 2: младшая половина — пустая (нули), старшая — ALES.
    writeHalf(bytes, 10, ALES_WORD);
    // Слово 3 — выравнивание команды на границу 8 байт (gas/config/tc-e2k.c:9488-9492): нули.
  }
  return bytes;
}

// ─────────────────────────────────────────────────────────────────────────────
// РАЗБОР
// ─────────────────────────────────────────────────────────────────────────────

function readWord(bytes: Uint8Array, offset: number): number {
  return (
    ((bytes[offset]! | (bytes[offset + 1]! << 8) | (bytes[offset + 2]! << 16) | (bytes[offset + 3]! << 24)) >>> 0)
  );
}

function readHalf(bytes: Uint8Array, offset: number): number {
  return (bytes[offset]! | (bytes[offset + 1]! << 8)) >>> 0;
}

function fieldOf(word: number, field: { shift: number; mask: number }): number {
  return (word >>> field.shift) & field.mask;
}

function exactlyOneBit(mask: number): number {
  return mask !== 0 && (mask & (mask - 1)) === 0 ? mask : -1;
}

/**
 * Разобрать байты в инструкцию.
 *
 * Отвергается всё, что эта реализация не кодирует: чужой размер, установленные поля, которых
 * интерфейс не выражает (SS/CS/CDS/PLS/LTS, спекулятивный режим, неизвестный код операции,
 * ненулевое выравнивание) — «не терять поле молча» (то же правило, что у оболочки).
 *
 * @throws EncodingRefusedError если размер или структура команды вне реализованных форм
 * @throws EncodingError если поля выразимы, но противоречивы
 */
function decodeReal(bytes: Uint8Array): AsmInstruction {
  if (!REAL_INSTRUCTION_SIZES.includes(bytes.length)) {
    throw new EncodingRefusedError(
      `НЕТ В ИСТОЧНИКЕ: длина ${bytes.length} байт — команда e2k кратна 8 и состоит из 8 или 16 байт ` +
        "(qemu/target/e2k/instr-bits.h:41-45); в этой реализации реализованы формы 8 и 16 байт",
    );
  }
  const hs = readWord(bytes, 0);
  const lng = fieldOf(hs, HS.lng);
  const size = (lng + 1) * 8;
  if (size !== bytes.length) {
    throw new EncodingError(`длина по HS: ${size} байт, в потоке ${bytes.length}`);
  }
  // Поля, которых интерфейс не выражает, обязаны быть нулевыми.
  for (const [name, field] of [
    ["nop", HS.nop],
    ["lm", HS.lm],
    ["x (бит 11)", HS.x],
    ["SS", HS.ss],
    ["sw", HS.sw],
    ["CS0/CS1", HS.cs],
    ["CDS", HS.cd],
    ["PLS", HS.pl],
  ] as const) {
    if (fieldOf(hs, field) !== 0) {
      throw new EncodingError(
        `поле ${name} = ${fieldOf(hs, field)}, но интерфейс его не выражает — разбор отвергнут ` +
          "(иначе подмена бита в нём вернула бы ту же инструкцию)",
      );
    }
  }
  const mdl = fieldOf(hs, HS.mdl);
  if (mdl !== 1) {
    throw new EncodingRefusedError(
      `НЕТ В ИСТОЧНИКЕ: «средняя точка» mdl = ${mdl}; реализована одна операция на команду ` +
        "(HS + слог ALS), то есть mdl = 1 (gas/config/tc-e2k.c:9366)",
    );
  }
  const alMask = fieldOf(hs, HS.al);
  const aleMask = fieldOf(hs, HS.ale);
  const alsBit = exactlyOneBit(alMask);
  if (alsBit < 0) {
    throw new EncodingRefusedError(
      `НЕТ В ИСТОЧНИКЕ: слогов ALS в команде ${alMask === 0 ? "нет" : "больше одного"} (al = 0x${alMask.toString(16)}); ` +
        "реализована одна операция на команду",
    );
  }
  const channel = Math.log2(alsBit);
  if (aleMask !== 0 && aleMask !== alsBit) {
    throw new EncodingRefusedError(
      `НЕТ В ИСТОЧНИКЕ: полуслог ALES (ale = 0x${aleMask.toString(16)}) не парен со слогом ALS канала ${channel}`,
    );
  }
  const long = aleMask === alsBit;
  const words = bytes.length / 4;
  if (long !== (words === 4)) {
    throw new EncodingError(
      `форма не сходится с длиной: полуслог ALES ${long ? "есть" : "нет"}, слов ${words}`,
    );
  }

  const als = readWord(bytes, 4);
  if (((als >>> HS.speculative) & 1) !== 0) {
    throw new EncodingError("бит спекулятивного режима установлен, но интерфейс его не выражает");
  }
  const opc = (als >>> 24) & 0x7f;
  const src1 = (als >>> 16) & 0xff;
  const src2 = (als >>> 8) & 0xff;
  const dst = als & 0xff;

  if (long) {
    const ales = readHalf(bytes, 10);
    if (ales !== ALES_WORD) {
      throw new EncodingError(
        `полуслог ALES = 0x${ales.toString(16)}, ожидался 0x${ALES_WORD.toString(16)} ` +
          "(EXT = 0x1, NONE = 0xc0 — include/opcode/e2k.h:68,93)",
      );
    }
    if (readHalf(bytes, 8) !== 0 || readWord(bytes, 12) !== 0) {
      throw new EncodingError("ненулевые байты выравнивания: поле, которого интерфейс не выражает");
    }
  }

  const candidates = REAL_OPCODES.filter(
    (candidate) =>
      candidate.opc === opc && (candidate.form === "ALF11") === long && candidate.channels.includes(channel),
  );
  if (candidates.length === 0) {
    throw new EncodingRefusedError(
      `НЕТ В ИСТОЧНИКЕ: код операции 0x${opc.toString(16)} (канал ${channel}, ` +
        `${long ? "длинная форма" : "короткая форма"}) не входит в реализованные формы; ` +
        "состав — docs/e2k-opcodes-real.md",
    );
  }
  if (candidates.length > 1) {
    throw new EncodingRefusedError(
      `НЕТ В ИСТОЧНИКЕ: код операции 0x${opc.toString(16)} на канале ${channel} неоднозначен в реализованной ` +
        `таблице (${candidates.map((candidate) => candidate.mnemonic).join(", ")}) — разбор отвергнут`,
    );
  }
  const entry = candidates[0]!;
  if (entry.form === "ALF2" && src1 !== ALES_OPCE_NONE) {
    throw new EncodingError(
      `«${entry.mnemonic}»: расширение opce = 0x${src1.toString(16)}, ожидалось 0x${ALES_OPCE_NONE.toString(16)} ` +
        "(NONE — include/opcode/e2k.h:93)",
    );
  }
  // Проверяются только те поля, которые форма действительно несёт: у ALF2 на месте src1 лежит
  // расширение opce, а не регистр.
  for (const slot of entry.operands) {
    const value = slot === "src1" ? src1 : slot === "src2" ? src2 : dst;
    if (value > REAL_MAX_REGISTER) {
      throw new EncodingError(`регистр ${value} не выражается полем слога (0..${REAL_MAX_REGISTER})`);
    }
  }
  const operands: Operand[] = entry.operands.map((slot) => ({
    kind: "reg" as const,
    index: slot === "src1" ? src1 : slot === "src2" ? src2 : dst,
  }));
  return { mnemonic: entry.mnemonic, channel, operands };
}

// ─────────────────────────────────────────────────────────────────────────────
// РЕАЛИЗАЦИЯ
// ─────────────────────────────────────────────────────────────────────────────

/** Создать реальный бэкенд `e2k`. */
export function createRealE2kEncoder(): Encoder {
  return {
    description: REAL_E2K_DESCRIPTION,
    encode: encodeReal,
    decode: decodeReal,
  };
}
