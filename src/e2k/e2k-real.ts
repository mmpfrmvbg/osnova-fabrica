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
  registerFileOf,
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
export type RealForm = "ALF1" | "ALF2" | "ALF11" | "ALF7";

/**
 * Слот операнда в слоге. Порядок в `operands` — порядок операндов интерфейса (результат последним).
 *
 * `pdst` — **предикат**-приёмник сравнения (поле `pdst[4:0]` формы ALF7), а не регистр: в
 * `ARGS_*` записи таблицы его нет, он принадлежит форме.
 */
export type RealSlot = "src1" | "src2" | "dst" | "pdst";

/**
 * Формат аргумента: `S` — одиночный регистр (`%b[N]`), `D` — двойной (`%db[N]`),
 * `P` — **предикат** (`%predN`, поле `pdst`).
 * В таблице МЦСТ первым двум соответствуют `SINGLE`/`DOUBLE` в `ARGS_*`
 * (`include/opcode/e2k.h:109-169`); `P` в `ARGS_*` отсутствует — предикат-приёмник задан формой.
 */
export type RealRegFormat = "S" | "D" | "P";

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
  /**
   * Формат регистра по каждому операнду: `S` — одиночный (`%b[N]`), `D` — двойной (`%db[N]`).
   * Источник — поле `ARGS_*` записи таблицы МЦСТ (`argsSource`). Нужен для записи образца
   * в ассемблерной форме МЦСТ: `as` различает `%b[N]` и `%db[N]` и кодирует их по-разному.
   */
  readonly argFormats: readonly RealRegFormat[];
  /** Источник форматов аргументов (`ARGS_*`). */
  readonly argsSource: string;
  /**
   * Код условия сравнения (`cmpopce[7:5]`) — только у формы ALF7.
   * Значения — из таблицы МЦСТ (`opcodes/e2k-opc.h:989-1064`): 6 «меньше», 7 «меньше или равно»,
   * 2 «равно» и так далее по набору `o,b,e,be,s,p,l,le`.
   */
  readonly cmpOpce?: number;
  /**
   * Обязательное поле `nop` заголовочного слога — только у формы ALF7.
   *
   * Не наша выдумка: `gas/config/tc-e2k.c:5923` берёт это число из шаблона записи
   * (`((e2k_alf7_opcode_templ *) alf)->implicit_nops`), а в таблице у каждой записи `cmp*` стоит
   * `2`; дизассемблер МЦСТ печатает поле открытым текстом (`nop 2`). Измерено: байты HS у
   * сравнения — `01 01 00 04`, у `adds` — `01 00 00 04`.
   */
  readonly implicitNops?: number;
  /** Источник: файл:строка таблицы опкодов. */
  readonly source: string;
  /** Источник раскладки полей формы. */
  readonly formSource: string;
}

const ALF1_SOURCE = "qemu/target/e2k/syllab-format.h:39-41 (ALF1: dst[7:0], src2[15:8], src1[23:16])";
const ALF2_SOURCE = "qemu/target/e2k/syllab-format.h:43-45 (ALF2: dst[7:0], src2[15:8], opce[23:16])";
const ALF11_SOURCE = "qemu/target/e2k/syllab-format.h:85-91 (ALEF: opc2[15:8], opce[7:0])";
const ALF7_SOURCE =
  "qemu/target/e2k/syllab-format.h:59-63 (ALF7: src1[23:16], src2[15:8], cmpopce[7:5], pdst[4:0]); " +
  "opcodes/e2k-dis.c:846-1010 (ALOPF7 различается по битам 7:5 слова ALF)";

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
  { mnemonic: "ands", opc: 0x00, form: "ALF1", operands: ["src1", "src2", "dst"], argFormats: ["S", "S", "S"], argsSource: "opcodes/e2k-opc.h:79 (ARGS_SSS)", channels: ALL_CHANNELS, source: "opcodes/e2k-opc.h:79", formSource: ALF1_SOURCE },
  { mnemonic: "andd", opc: 0x01, form: "ALF1", operands: ["src1", "src2", "dst"], argFormats: ["D", "D", "D"], argsSource: "opcodes/e2k-opc.h:84 (ARGS_DDD)", channels: ALL_CHANNELS, source: "opcodes/e2k-opc.h:84", formSource: ALF1_SOURCE },
  { mnemonic: "ors", opc: 0x04, form: "ALF1", operands: ["src1", "src2", "dst"], argFormats: ["S", "S", "S"], argsSource: "opcodes/e2k-opc.h:99 (ARGS_SSS)", channels: ALL_CHANNELS, source: "opcodes/e2k-opc.h:99", formSource: ALF1_SOURCE },
  { mnemonic: "ord", opc: 0x05, form: "ALF1", operands: ["src1", "src2", "dst"], argFormats: ["D", "D", "D"], argsSource: "opcodes/e2k-opc.h:104 (ARGS_DDD)", channels: ALL_CHANNELS, source: "opcodes/e2k-opc.h:104", formSource: ALF1_SOURCE },
  { mnemonic: "xors", opc: 0x08, form: "ALF1", operands: ["src1", "src2", "dst"], argFormats: ["S", "S", "S"], argsSource: "opcodes/e2k-opc.h:119 (ARGS_SSS)", channels: ALL_CHANNELS, source: "opcodes/e2k-opc.h:119", formSource: ALF1_SOURCE },
  { mnemonic: "xord", opc: 0x09, form: "ALF1", operands: ["src1", "src2", "dst"], argFormats: ["D", "D", "D"], argsSource: "opcodes/e2k-opc.h:124 (ARGS_DDD)", channels: ALL_CHANNELS, source: "opcodes/e2k-opc.h:124", formSource: ALF1_SOURCE },
  { mnemonic: "sxt", opc: 0x0c, form: "ALF1", operands: ["src1", "src2", "dst"], argFormats: ["S", "S", "D"], argsSource: "opcodes/e2k-opc.h:199 (ARGS_SSD)", channels: ALL_CHANNELS, source: "opcodes/e2k-opc.h:199", formSource: ALF1_SOURCE },
  { mnemonic: "adds", opc: 0x10, form: "ALF1", operands: ["src1", "src2", "dst"], argFormats: ["S", "S", "S"], argsSource: "opcodes/e2k-opc.h:19 (ARGS_SSS)", channels: ALL_CHANNELS, source: "opcodes/e2k-opc.h:19", formSource: ALF1_SOURCE },
  { mnemonic: "addd", opc: 0x11, form: "ALF1", operands: ["src1", "src2", "dst"], argFormats: ["D", "D", "D"], argsSource: "opcodes/e2k-opc.h:24 (ARGS_DDD)", channels: ALL_CHANNELS, source: "opcodes/e2k-opc.h:24", formSource: ALF1_SOURCE },
  { mnemonic: "subs", opc: 0x12, form: "ALF1", operands: ["src1", "src2", "dst"], argFormats: ["S", "S", "S"], argsSource: "opcodes/e2k-opc.h:29 (ARGS_SSS)", channels: ALL_CHANNELS, source: "opcodes/e2k-opc.h:29", formSource: ALF1_SOURCE },
  { mnemonic: "subd", opc: 0x13, form: "ALF1", operands: ["src1", "src2", "dst"], argFormats: ["D", "D", "D"], argsSource: "opcodes/e2k-opc.h:34 (ARGS_DDD)", channels: ALL_CHANNELS, source: "opcodes/e2k-opc.h:34", formSource: ALF1_SOURCE },
  { mnemonic: "scls", opc: 0x14, form: "ALF1", operands: ["src1", "src2", "dst"], argFormats: ["S", "S", "S"], argsSource: "opcodes/e2k-opc.h:159 (ARGS_SSS)", channels: ALL_CHANNELS, source: "opcodes/e2k-opc.h:159", formSource: ALF1_SOURCE },
  { mnemonic: "scld", opc: 0x15, form: "ALF1", operands: ["src1", "src2", "dst"], argFormats: ["D", "D", "D"], argsSource: "opcodes/e2k-opc.h:164 (ARGS_DDD)", channels: ALL_CHANNELS, source: "opcodes/e2k-opc.h:164", formSource: ALF1_SOURCE },
  { mnemonic: "shls", opc: 0x18, form: "ALF1", operands: ["src1", "src2", "dst"], argFormats: ["S", "S", "S"], argsSource: "opcodes/e2k-opc.h:139 (ARGS_SSS)", channels: ALL_CHANNELS, source: "opcodes/e2k-opc.h:139", formSource: ALF1_SOURCE },
  { mnemonic: "shrs", opc: 0x1a, form: "ALF1", operands: ["src1", "src2", "dst"], argFormats: ["S", "S", "S"], argsSource: "opcodes/e2k-opc.h:149 (ARGS_SSS)", channels: ALL_CHANNELS, source: "opcodes/e2k-opc.h:149", formSource: ALF1_SOURCE },
  { mnemonic: "sars", opc: 0x1c, form: "ALF1", operands: ["src1", "src2", "dst"], argFormats: ["S", "S", "S"], argsSource: "opcodes/e2k-opc.h:179 (ARGS_SSS)", channels: ALL_CHANNELS, source: "opcodes/e2k-opc.h:179", formSource: ALF1_SOURCE },
  // ALF2 — слог ALS, расширение в битах 23:16, операнды src2, dst.
  // Каналы — `{1, 1, 0, 1, 1, 0}` в таблице МЦСТ (без 2 и 5), как у длинной формы:
  // исправлено при сверке с ассемблером (`docs/e2k-external-as.md`).
  { mnemonic: "movts", opc: 0x60, form: "ALF2", operands: ["src2", "dst"], argFormats: ["S", "S"], argsSource: "opcodes/e2k-opc.h:644 (ARGS_SS)", channels: LONG_CHANNELS, source: "opcodes/e2k-opc.h:644", formSource: ALF2_SOURCE },
  { mnemonic: "movtd", opc: 0x61, form: "ALF2", operands: ["src2", "dst"], argFormats: ["D", "D"], argsSource: "opcodes/e2k-opc.h:664 (ARGS_DD)", channels: LONG_CHANNELS, source: "opcodes/e2k-opc.h:664", formSource: ALF2_SOURCE },
  // ALOPF11 — слог ALS + полуслог ALES
  { mnemonic: "muls", opc: 0x20, form: "ALF11", operands: ["src1", "src2", "dst"], argFormats: ["S", "S", "S"], argsSource: "opcodes/e2k-opc.h:1434 (ARGS_SSS)", channels: LONG_CHANNELS, source: "opcodes/e2k-opc.h:1434", formSource: ALF11_SOURCE },
  { mnemonic: "muld", opc: 0x21, form: "ALF11", operands: ["src1", "src2", "dst"], argFormats: ["D", "D", "D"], argsSource: "opcodes/e2k-opc.h:1439 (ARGS_DDD)", channels: LONG_CHANNELS, source: "opcodes/e2k-opc.h:1439", formSource: ALF11_SOURCE },
  { mnemonic: "umulx", opc: 0x22, form: "ALF11", operands: ["src1", "src2", "dst"], argFormats: ["S", "S", "D"], argsSource: "opcodes/e2k-opc.h:1444 (ARGS_SSD)", channels: LONG_CHANNELS, source: "opcodes/e2k-opc.h:1444", formSource: ALF11_SOURCE },
  { mnemonic: "smulx", opc: 0x23, form: "ALF11", operands: ["src1", "src2", "dst"], argFormats: ["S", "S", "D"], argsSource: "opcodes/e2k-opc.h:1449 (ARGS_SSD)", channels: LONG_CHANNELS, source: "opcodes/e2k-opc.h:1449", formSource: ALF11_SOURCE },
  { mnemonic: "umulhd", opc: 0x70, form: "ALF11", operands: ["src1", "src2", "dst"], argFormats: ["D", "D", "D"], argsSource: "opcodes/e2k-opc.h:3169 (ARGS_DDD)", channels: LONG_CHANNELS, source: "opcodes/e2k-opc.h:3169", formSource: ALF11_SOURCE },
  { mnemonic: "smulhd", opc: 0x71, form: "ALF11", operands: ["src1", "src2", "dst"], argFormats: ["D", "D", "D"], argsSource: "opcodes/e2k-opc.h:3174 (ARGS_DDD)", channels: LONG_CHANNELS, source: "opcodes/e2k-opc.h:3174", formSource: ALF11_SOURCE },
  // ALOPF7 — слог ALS, приёмник — ПРЕДИКАТ (`pdst`), условие — `cmpopce`.
  // В наборе условий таблицы (`o,b,e,be,s,p,l,le`) условий «больше»/«больше или равно» НЕТ;
  // они выражаются отрицанием предиката в `ct` (`? ~%predN`, `gas/config/tc-e2k.c:4588-4594`).
  { mnemonic: "cmplsb", opc: 0x20, form: "ALF7", operands: ["src1", "src2", "pdst"], argFormats: ["S", "S", "P"], argsSource: "opcodes/e2k-opc.h:1019 (ARGS_SS; приёмник — pdst формы ALF7)", channels: LONG_CHANNELS, cmpOpce: 0x6, implicitNops: 2, source: "opcodes/e2k-opc.h:1019", formSource: ALF7_SOURCE },
  { mnemonic: "cmplesb", opc: 0x20, form: "ALF7", operands: ["src1", "src2", "pdst"], argFormats: ["S", "S", "P"], argsSource: "opcodes/e2k-opc.h:1024 (ARGS_SS; приёмник — pdst формы ALF7)", channels: LONG_CHANNELS, cmpOpce: 0x7, implicitNops: 2, source: "opcodes/e2k-opc.h:1024", formSource: ALF7_SOURCE },
  { mnemonic: "cmpesb", opc: 0x20, form: "ALF7", operands: ["src1", "src2", "pdst"], argFormats: ["S", "S", "P"], argsSource: "opcodes/e2k-opc.h:999 (ARGS_SS; приёмник — pdst формы ALF7)", channels: LONG_CHANNELS, cmpOpce: 0x2, implicitNops: 2, source: "opcodes/e2k-opc.h:999", formSource: ALF7_SOURCE },
];

/**
 * Слог ALS одной короткой команды — материал широкой команды (`docs/e2k-wide-commands.md`).
 *
 * Зачем отдельный экспорт: широкая команда — это HS плюс **несколько** слогов ALS; сборка
 * нескольких слогов живёт в `src/e2k/widePacker.ts`, а раскладка полей — здесь, в одном месте с
 * одиночным кодированием. Иначе появилась бы вторая реализация раскладки ALS, и расхождение
 * между ними не поймал бы ни один оракул.
 */
export interface AlsSyllable {
  readonly form: RealForm;
  /** Разрешённые каналы операции (список, не маска). */
  readonly channels: readonly number[];
  /** Канал, выбранный для этой инструкции. */
  readonly channel: number;
  /** Слово слога ALS. */
  readonly als: number;
  /** Полуслог ALES (16 бит) — только у длинной формы ALF11. */
  readonly ales?: number;
  /** Обязательные `nop` формы (`implicitNops`); у сравнений — 2. */
  readonly implicitNops: number;
}

/**
 * Разложить команду в слог ALS (и полуслог ALES).
 *
 * Отказывает там, где одиночный кодировщик пошёл бы другой ветвью: литералы (`movts` с `_f16s`),
 * управляющие слоги (`sdisp`, `call`, `ct`, `setbn`) и неизвестные мнемоники — у них слога ALS
 * либо нет, либо он собирается вместе с LTS/CS. Причина отказа — та же, что у кодировщика.
 */
export function alsSyllableOf(instruction: AsmInstruction): AlsSyllable {
  const entry = BY_MNEMONIC.get(instruction.mnemonic);
  if (entry === undefined) throw new EncodingRefusedError(realRefusalReason(instruction.mnemonic));
  const channel = channelOf(entry, instruction.channel);
  const fields = fieldsOf(entry, instruction.operands);
  return {
    form: entry.form,
    channels: entry.channels,
    channel,
    als: alsWord(entry, fields),
    ...(entry.form === "ALF11" ? { ales: ALES_WORD } : {}),
    implicitNops: entry.implicitNops ?? 0,
  };
}

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
    "(opcodes/e2k-opc.h) и нет в реализованных формах (ALF1, ALF2, ALF7, ALES/ALOPF11); " +
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
    "реализованы формы: короткая (слог ALS, 8 байт) — ALF1, ALF2 и ALF7 (сравнения с предикатом-приёмником `pdst`), " +
    "и длинная (слог ALS + полуслог ALES, 16 байт) — ALF11; по одной операции на команду; " +
    "операции без слога ALS (AAS-адресация MOVAB…MOVAQ, управление ct/call/return, " +
    "SS/CS/CDS/PLS/LTS-слоги) НЕ реализованы и отвергаются; поле instructionSize заявляет короткую форму — " +
    "длинная форма занимает 16 байт (REAL_LONG_FORM_SIZE), шлюз auditEncoder рассчитан на одну длину; " +
    "у сравнений ALF7 поле `nop` заголовочного слога равно 2 (implicit_nops шаблона, gas/config/tc-e2k.c:5923), " +
    "и это воспроизводится, а не игнорируется; байты не сверены с MCST-objdump или QEMU: " +
    "в окружении нет компилятора C (docs/e2k-qemu-build.md §2)",
};

// ─────────────────────────────────────────────────────────────────────────────
// КОДИРОВАНИЕ
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Старший бит поля регистра: оконный файл (`%r[N]`) против базового (`%b[N]`).
 *
 * Раскладка — `binutils-gdb/opcodes/e2k-dis.c:416-419`: `0x00-0x7f` — `%b[N]`, `0x80-0xbf` — `%rN`.
 * Измерено ассемблером МЦСТ: `movts,0 1, %b[0]` → поле `0x00`, `movts,0 1, %r0` → поле `0x80`
 * (`docs/e2k-minimal-elf.md` §6).
 */
export const REGISTER_FILE_WINDOW = 0x80;

/** Значение поля регистра: номер вместе со старшим битом файла. */
function registerFieldValue(operand: Operand, slot: RealSlot, mnemonic: string): number {
  if (operand.kind !== "reg") {
    throw new EncodingError(`«${mnemonic}»: операнд ${slot} обязан быть регистром`);
  }
  if (!Number.isInteger(operand.index) || operand.index < 0 || operand.index > REAL_MAX_REGISTER) {
    throw new EncodingError(
      `«${mnemonic}»: регистр ${String(operand.index)} не выражается полем слога (0..${REAL_MAX_REGISTER})`,
    );
  }
  return (registerFileOf(operand) === "window" ? REGISTER_FILE_WINDOW : 0) | operand.index;
}

function registerField(operand: Operand | undefined, slot: RealSlot, mnemonic: string): number {
  if (operand === undefined) {
    throw new EncodingError(`«${mnemonic}»: операнд ${slot} обязан быть регистром`);
  }
  return registerFieldValue(operand, slot, mnemonic);
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

/** Число предикатов: поле `pdst[4:0]` — пять бит (`qemu/target/e2k/syllab-format.h:61`). */
export const PREDICATE_COUNT = 32;

/**
 * Поле предиката-приёмника.
 *
 * Предикат — **не** регистр: `%predN` лежит в отдельном файле, и подставить вместо него `%b[N]`
 * (или наоборот) значило бы подменить поле. Поэтому вид операнда проверяется, а не приводится.
 */
function predicateField(operand: Operand | undefined, mnemonic: string): number {
  if (operand === undefined || operand.kind !== "pred") {
    throw new EncodingError(
      `«${mnemonic}»: приёмник сравнения обязан быть предикатом (%predN), а не регистром — ` +
        "pdst[4:0] и поле регистра это разные файлы (qemu/target/e2k/syllab-format.h:61)",
    );
  }
  if (!Number.isInteger(operand.index) || operand.index < 0 || operand.index >= PREDICATE_COUNT) {
    throw new EncodingError(
      `«${mnemonic}»: предикат ${String(operand.index)} не выражается полем pdst (0..${PREDICATE_COUNT - 1}; ` +
        "qemu/target/e2k/syllab-format.h:61)",
    );
  }
  return operand.index;
}

/** Разложить операнды интерфейса по полям слога ALS. */
function fieldsOf(
  entry: RealOpcodeEntry,
  operands: readonly Operand[],
): { src1: number; src2: number; dst: number; pdst: number } {
  if (operands.length !== entry.operands.length) {
    throw new EncodingError(
      `«${entry.mnemonic}»: операндов ${operands.length}, форма ${entry.form} несёт ${entry.operands.length} ` +
        `(${entry.operands.join(", ")})`,
    );
  }
  let src1 = 0;
  let src2 = 0;
  let dst = 0;
  let pdst = 0;
  entry.operands.forEach((slot, index) => {
    if (slot === "pdst") {
      pdst = predicateField(operands[index], entry.mnemonic);
      return;
    }
    const value = registerField(operands[index], slot, entry.mnemonic);
    if (slot === "src1") src1 = value;
    else if (slot === "src2") src2 = value;
    else dst = value;
  });
  if (entry.form === "ALF2") {
    // У ALF2 на месте src1 лежит расширение opce: операнда src1 у операции нет.
    src1 = ALES_OPCE_NONE;
  }
  return { src1, src2, dst, pdst };
}

/**
 * Слово слога ALS (4 байта, little-endian).
 *
 * Раскладка ALF1/ALF2: `opc[31:24] | src1[23:16] | src2[15:8] | dst[7:0]`.
 * Раскладка ALF7 (сравнение): на месте младшего байта — `cmpopce[7:5] | pdst[4:0]`
 * (`qemu/target/e2k/syllab-format.h:59-63`); измерено ассемблером: `cmplsb … %pred0` → `c0`,
 * `cmplesb … %pred0` → `e0`, `cmpesb … %pred0` → `40`.
 */
function alsWord(
  entry: RealOpcodeEntry,
  fields: { src1: number; src2: number; dst: number; pdst: number },
): number {
  if (entry.form === "ALF7") {
    if (entry.cmpOpce === undefined) {
      throw new EncodingError(`«${entry.mnemonic}»: у формы ALF7 не назван код условия (cmpopce)`);
    }
    return (
      ((entry.opc & 0x7f) << 24) |
      ((fields.src1 & 0xff) << 16) |
      ((fields.src2 & 0xff) << 8) |
      ((entry.cmpOpce & 0x7) << 5) |
      (fields.pdst & 0x1f)
    );
  }
  return (
    ((entry.opc & 0x7f) << 24) | ((fields.src1 & 0xff) << 16) | ((fields.src2 & 0xff) << 8) | (fields.dst & 0xff)
  );
}

/**
 * Заголовочный слог (HS).
 *
 * Поле `nop` (биты 9:7) берётся из записи формы: у сравнений ALF7 оно равно 2
 * (`gas/config/tc-e2k.c:5923` — `implicit_nops` шаблона; измерено: HS сравнения `01 01 00 04`
 * против `01 00 00 04` у `adds`).
 */
function headerWord(entry: RealOpcodeEntry, channel: number, long: boolean): number {
  const mdl = 1; // HS + ALS = два 4-байтовых слога до «средней точки» (gas/config/tc-e2k.c:9366)
  const words = long ? REAL_LONG_FORM_SIZE / 4 : REAL_SHORT_FORM_SIZE / 4;
  const lng = words / 2 - 1; // gas/config/tc-e2k.c:9577
  let hs = ((lng & HS.lng.mask) << HS.lng.shift) | ((mdl & HS.mdl.mask) << HS.mdl.shift);
  hs |= ((entry.implicitNops ?? 0) & HS.nop.mask) << HS.nop.shift;
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
  const control = REAL_CONTROL_OPCODES.find((candidate) => candidate.mnemonic === instruction.mnemonic);
  if (control !== undefined) return encodeControl(control, instruction);
  const entry = BY_MNEMONIC.get(instruction.mnemonic);
  if (entry === undefined) throw new EncodingRefusedError(realRefusalReason(instruction.mnemonic));
  const channel = channelOf(entry, instruction.channel);
  // 64-битный литерал (`imm64`) кодируется формой 0xdc: два LTS-слова. Отдельная ветвь, потому
  // что значение — bigint, а короткие формы работают с number.
  const wide = instruction.operands.findIndex((operand) => operand.kind === "imm64");
  if (wide >= 0) {
    const literal = instruction.operands[wide];
    if (literal === undefined || literal.kind !== "imm64") throw new EncodingError("ожидался 64-битный литерал");
    return encodeImm64(entry, channel, instruction.operands, wide, literal.value);
  }
  const literal = literalOperand(entry, instruction.operands);
  if (literal !== undefined) return encodeWithLiteral(entry, channel, instruction.operands, literal);
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
// СЛОГИ УПРАВЛЕНИЯ (SS, CS0, CS1) — извлечены в docs/e2k-syllables-real.md
// ─────────────────────────────────────────────────────────────────────────────

/** Поле инструкции управления: `ctpr` — номер регистра подготовки, `cond` — код условия `ct`,
 * `disp` — смещение перехода в восьмибайтовых словах, `wbs` — параметр `call`. */
export type RealControlSlot = "ctpr" | "cond" | "disp" | "sdisp" | "wbs" | "rsz" | "rbs" | "rcur";

/**
 * Инструкция, которая кодируется **слогами управления**, а не слогом ALS.
 *
 * Такие инструкции в таблице опкодов МЦСТ **не лежат** — их разбирает сам ассемблер
 * (`gas/config/tc-e2k.c`, функции `parse_ct_args`, `parse_hicall_args`, `parse_pref_args`), и
 * кодируются они прямо в поля слогов. Поэтому они вынесены в отдельную таблицу, а не
 * подмешаны к `REAL_OPCODES`.
 */
export interface RealControlEntry {
  /** Мнемоника — копия из ассемблера МЦСТ посимвольно (`as` принимает именно эти имена). */
  readonly mnemonic: string;
  readonly form: "SS" | "CS0_DISP" | "CS0_SDISP" | "CS0_RETURN" | "CS1_SETBN" | "CS1_CALL";
  readonly operands: readonly RealControlSlot[];
  readonly size: number;
  /** Источник полей слога. */
  readonly formSource: string;
  /** Источник мнемоники и набора операндов. */
  readonly source: string;
}

/** Источник полей SS — служебного слога. */
const SS_SOURCE =
  "qemu/target/e2k/syllab-format.h:16-29 (HS) и opcodes/e2k-dis.c:1584-1640 (print_ctcond: cond_type = ctcond>>5, psrc = ctcond&0x1f)";
/** Источник полей CS0 — управляющего слога 0. */
const CS0_SOURCE =
  "qemu/target/e2k/syllab-format.h:94-101 (C0F: opc[31:28], C0F2: disp[27:0]); opcodes/e2k-dis.c:1906-1911 (ctpr[31:30], ctp_opc[29:28])";
/** Источник полей CS1 — управляющего слога 1. */
const CS1_SOURCE = "qemu/target/e2k/syllab-format.h:102-119 (C1F1: opc[31:28], param[27:0])";

/** Код условия «всегда» (`CTC bastOND_ALWAYS = 32`, `gas/config/tc-e2k.c:4589`). */
export const CT_COND_ALWAYS = 0x20;

/**
 * Инструкции управления. Байты сверены с ассемблером МЦСТ (`docs/e2k-syllables-real.md` §4):
 * `ct %ctpr1` → `01 10 00 00 20 04 00 c0`, `disp %ctpr1, …` → `01 40 00 00 01 00 00 40`,
 * `return %ctpr3` → `01 40 00 00 00 00 00 f0`, `call %ctpr1, wbs=16` →
 * `12 90 00 00 20 04 00 c0 10 00 00 50 00 00 00 00`.
 */
export const REAL_CONTROL_OPCODES: readonly RealControlEntry[] = [
  {
    mnemonic: "ct",
    form: "SS",
    operands: ["ctpr", "cond"],
    size: 8,
    formSource: SS_SOURCE,
    source: "gas/config/tc-e2k.c:6796-6861 (parse_ct_args), :6658-6760 (parse_ctcond)",
  },
  {
    mnemonic: "disp",
    form: "CS0_DISP",
    operands: ["ctpr", "disp"],
    size: 8,
    formSource: CS0_SOURCE,
    source: "gas/config/tc-e2k.c:6000-6070 (разбор disp), opcodes/e2k-dis.c:1896-1902 (таблица cs0_ops)",
  },
  {
    mnemonic: "sdisp",
    form: "CS0_SDISP",
    operands: ["ctpr", "sdisp"],
    size: 8,
    formSource: CS0_SOURCE,
    source:
      "opcodes/e2k-dis.c:1899-1901 (cs0_ops[1..3][2] = SDISP; печать `cs0 & 0x1f` — :2006-2007); " +
      "gas/config/tc-e2k.c:6054-6073 (значение 0..31, символ запрещён); " +
      "qemu/target/e2k/tcg/translate-ctp.c:142-184 (E2K_OP_SDISP: цель = OSCUD.base + sdisp*2048, " +
      "тег CTPSL/CTPEW выбирается по psr.pm и osem — :174)",
  },
  {
    mnemonic: "return",
    form: "CS0_RETURN",
    operands: ["ctpr"],
    size: 8,
    formSource: CS0_SOURCE,
    source: "gas/config/tc-e2k.c:7004 (CS0.ctp_opc = 0 для RETURN), opcodes/e2k-dis.c:1901 (cs0_ops[3][3] = RETURN)",
  },
  {
    mnemonic: "setbn",
    form: "CS1_SETBN",
    operands: ["rsz", "rbs", "rcur"],
    size: 8,
    formSource: CS1_SOURCE,
    source:
      "qemu/target/e2k/syllab-format.h:107-117 (setbn — бит 26, rcur[17:12], rsz[11:6], rbs[5:0]); " +
      "opcodes/e2k-dis.c:2046-2056 (CS1.opc: SETBR = 4), :2121-2127 (печать setbn rcur/rsz/rbs); " +
      "gas/config/tc-e2k.c:6257-6301 (имена параметров setbn rsz=, rbs=, rcur=); " +
      "измерено ассемблером: `setbn rsz=4, rbs=0, rcur=0` → `01 80 00 00 00 01 00 44`",
  },
  {
    mnemonic: "call",
    form: "CS1_CALL",
    operands: ["ctpr", "wbs"],
    size: 16,
    formSource: CS1_SOURCE,
    source: "gas/config/tc-e2k.c:6832-6841 (CS1: call.opc = 5, call.param = wbs)",
  },
];

/** Инструкция управления по мнемонике. */
export function realControlOpcode(mnemonic: string): RealControlEntry | undefined {
  return REAL_CONTROL_OPCODES.find((entry) => entry.mnemonic === mnemonic);
}

/** Числовой операнд по индексу; отказ, если его нет или он не число. */
function immediateOf(instruction: AsmInstruction, index: number, slot: RealControlSlot): number {
  const operand = instruction.operands[index];
  if (operand === undefined || operand.kind !== "imm") {
    throw new EncodingError(`«${instruction.mnemonic}»: операнд ${slot} обязан быть числом`);
  }
  if (!Number.isInteger(operand.value)) {
    throw new EncodingError(`«${instruction.mnemonic}»: ${slot} = ${operand.value} — не целое`);
  }
  return operand.value;
}

/** Слог SS: `ipd=3` (значение ассемблера МЦСТ), `ctpr[11:10]`, `ctcond[8:0]`. */
function ssWord(ctpr: number, ctcond: number): number {
  if (ctpr < 1 || ctpr > 3) throw new EncodingError(`ctpr вне 1..3: ${ctpr}`);
  if (ctcond < 0 || ctcond > 0x1ff) throw new EncodingError(`код условия вне 9 бит: ${ctcond}`);
  return (0xc0000000 | ((ctpr & 0x3) << 10) | (ctcond & 0x1ff)) >>> 0;
}

/**
 * Границы поля `disp`: 28 бит со знаком (`syllab-format.h:100` — `C0F2.disp[27:0]`;
 * `translate-ctp.c:74` читает его `FIELD_SEX32`, то есть знаковым). Границы — из разрядности поля,
 * а не из удобства: −2²⁷ … 2²⁷−1 в восьмибайтовых единицах.
 */
export const DISP_BITS = 28;
export const DISP_MIN = -(2 ** (DISP_BITS - 1));
export const DISP_MAX = 2 ** (DISP_BITS - 1) - 1;

/**
 * Слог CS0 формата C0F2 (`disp`): `ctpr[31:30]`, `ctp_opc=0`, `disp[27:0]`.
 *
 * Смещение **знаковое**: отрицательное значение (переход назад) пишется в поле как
 * дополнительный код — измерено ассемблером (`disp %ctpr1, .L1` при цели на слово позади команды →
 * `ff ff ff 4f`). Значение вне поля — отказ, а не молчаливое усечение.
 */
function cs0DispWord(ctpr: number, disp: number): number {
  if (ctpr < 1 || ctpr > 3) throw new EncodingError(`ctpr вне 1..3: ${ctpr}`);
  if (!Number.isInteger(disp) || disp < DISP_MIN || disp > DISP_MAX) {
    throw new EncodingError(
      `disp = ${disp} не влезает в ${DISP_BITS}-битное знаковое поле C0F2.disp[27:0] ` +
        `(${DISP_MIN}..${DISP_MAX}): qemu/target/e2k/syllab-format.h:100, binutils-gdb/gas/config/tc-e2k.c:1191`,
    );
  }
  return (((ctpr & 0x3) << 30) | (disp & 0x0fffffff)) >>> 0;
}

/** Значение поля `disp` из слога CS0 — **знаковое** 28-битное (`FIELD_SEX32`, `translate-ctp.c:74`). */
function dispOf(cs0: number): number {
  const raw = cs0 & 0x0fffffff;
  return raw >= 2 ** (DISP_BITS - 1) ? raw - 2 ** DISP_BITS : raw;
}

/** Слог CS0 формата C0F1 (`return`): `ctpr=3`, `ctp_opc=3`. */
function cs0ReturnWord(ctpr: number): number {
  if (ctpr !== 3) throw new EncodingError(`return поддерживает только %ctpr3 (получено ${ctpr})`);
  return 0xf0000000 >>> 0;
}

/**
 * Слог CS0 формата C0F2 (`sdisp`): `ctpr[31:30]`, `ctp_opc=2`, смещение — младшие 5 бит.
 *
 * Измерено ассемблером МЦСТ: `sdisp %ctpr1, 3` → `01 40 00 00 03 00 00 60`,
 * `sdisp %ctpr2, 5` → `01 40 00 00 05 00 00 a0`, `sdisp %ctpr3, 1` → `01 40 00 00 01 00 00 e0`.
 * Отличие от `disp` — только `ctp_opc` (2 против 0): `disp %ctpr1, 3` → `01 40 00 00 03 00 00 40`.
 */
function cs0SdispWord(ctpr: number, sdisp: number): number {
  if (ctpr < 1 || ctpr > 3) throw new EncodingError(`sdisp: ctpr вне 1..3: ${ctpr}`);
  if (!Number.isInteger(sdisp) || sdisp < 0 || sdisp >= 32) {
    throw new EncodingError(
      `sdisp: смещение ${sdisp} вне 0..31 — так отвергает и ассемблер МЦСТ ` +
        "(`invalid value for CS0.disp in SDISP specified`, gas/config/tc-e2k.c:6054-6059)",
    );
  }
  return (((ctpr & 0x3) << 30) | (2 << 28) | (sdisp & 0x1f)) >>> 0;
}

/**
 * Слог CS1 формата `SETR`/`SETBR` (`setbn`, `setbp`): `opc=4`, бит 26 — setbn, бит 27 — setbp,
 * `rcur[17:12]`, `rsz[11:6]`, `rbs[5:0]`.
 *
 * Измерено ассемблером МЦСТ: `setbn rsz=4, rbs=0, rcur=0` → `01 80 00 00 00 01 00 44`;
 * `setbn rsz=1, rbs=2, rcur=3` → `01 80 00 00 42 30 00 44`; `setbp psz=5` → `01 80 00 00 00 00 14 48`.
 * Поля — `qemu/target/e2k/syllab-format.h:107-117` (`psz[22:18]`, `rcur[17:12]`, `rsz[11:6]`, `rbs[5:0]`,
 * `setbp` — бит 27, `setbn` — бит 26), значения opc — `opcodes/e2k-dis.c:2046-2056` (SETBR = 4).
 */
function cs1SetbnWord(rsz: number, rbs: number, rcur: number): number {
  for (const [name, value] of [["rsz", rsz], ["rbs", rbs], ["rcur", rcur]] as const) {
    if (!Number.isInteger(value) || value < 0 || value > 0x3f) {
      throw new EncodingError(`setbn: ${name} = ${value} вне 0..63 (поле 6 бит)`);
    }
  }
  return (((4 << 28) | (1 << 26) | ((rcur & 0x3f) << 12) | ((rsz & 0x3f) << 6) | (rbs & 0x3f)) >>> 0);
}

/** Слог CS1 формата C1F1 (`call`): `opc=5`, `param=wbs`. */
function cs1CallWord(wbs: number): number {
  if (wbs < 0 || wbs > 0x0fffffff) throw new EncodingError(`wbs вне 28 бит: ${wbs}`);
  return ((5 << 28) | (wbs & 0x0fffffff)) >>> 0;
}

function encodeControl(entry: RealControlEntry, instruction: AsmInstruction): Uint8Array {
  if (instruction.operands.length !== entry.operands.length) {
    throw new EncodingError(
      `«${entry.mnemonic}»: операндов ${instruction.operands.length}, форма ${entry.form} несёт ${entry.operands.length}`,
    );
  }
  if (instruction.channel !== 0) {
    throw new EncodingError(`«${entry.mnemonic}»: инструкция управления не несёт номер канала ALS`);
  }
  const values = new Map<RealControlSlot, number>();
  entry.operands.forEach((slot, index) => {
    values.set(slot, immediateOf(instruction, index, slot));
  });
  const bytes = new Uint8Array(entry.size);
  switch (entry.form) {
    case "SS": {
      // HS: SS присутствует (бит 12), mdl = 1, lng = 0 → 8 байт.
      writeWord(bytes, 0, 0x00001001);
      writeWord(bytes, 4, ssWord(values.get("ctpr")!, values.get("cond")!));
      return bytes;
    }
    case "CS0_DISP": {
      // HS: CS0 присутствует (бит 14), mdl = 1, lng = 0.
      writeWord(bytes, 0, 0x00004001);
      writeWord(bytes, 4, cs0DispWord(values.get("ctpr")!, values.get("disp")!));
      return bytes;
    }
    case "CS0_RETURN": {
      writeWord(bytes, 0, 0x00004001);
      writeWord(bytes, 4, cs0ReturnWord(values.get("ctpr")!));
      return bytes;
    }
    case "CS0_SDISP": {
      // HS тот же, что у CS0_DISP: CS0 присутствует (бит 14), mdl = 1, lng = 0.
      writeWord(bytes, 0, 0x00004001);
      writeWord(bytes, 4, cs0SdispWord(values.get("ctpr")!, values.get("sdisp")!));
      return bytes;
    }
    case "CS1_SETBN": {
      // HS: CS1 присутствует (бит 15), mdl = 1, lng = 0 → 8 байт (измерено: `01 80 00 00 …`).
      writeWord(bytes, 0, 0x00008001);
      writeWord(bytes, 4, cs1SetbnWord(values.get("rsz")!, values.get("rbs")!, values.get("rcur")!));
      return bytes;
    }
    case "CS1_CALL": {
      // HS: SS (12) + CS1 (15), mdl = 2 (три слога до средней точки), lng = 1 → 16 байт.
      writeWord(bytes, 0, 0x00009012);
      writeWord(bytes, 4, ssWord(values.get("ctpr")!, CT_COND_ALWAYS));
      writeWord(bytes, 8, cs1CallWord(values.get("wbs")!));
      return bytes;
    }
    default: {
      const unknown = entry as { form?: string };
      throw new EncodingError(`форма управления «${unknown.form}» не реализована`);
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// ЛИТЕРАЛЫ (LTS) — извлечены в docs/e2k-syllables-real.md
// ─────────────────────────────────────────────────────────────────────────────

/** Литеральный операнд: индекс слота и значение. */
interface LiteralOperand {
  readonly index: number;
  readonly value: number;
}

/**
 * Найти литеральный операнд (`imm`) в инструкции.
 *
 * Литералы поддержаны только для коротких форм ALF1/ALF2: у длинной формы (ALS + ALES) слог
 * литерала конкурирует за место с полуслогом ALES, и такая раскладка **не проверена**
 * ассемблером — а непроверенное в кодировщик не добавляется.
 */
function literalOperand(entry: RealOpcodeEntry, operands: readonly Operand[]): LiteralOperand | undefined {
  const index = operands.findIndex((operand) => operand.kind === "imm");
  if (index < 0) return undefined;
  if (entry.form === "ALF11") {
    throw new EncodingRefusedError(
      `«${entry.mnemonic}»: литерал в длинной форме (ALS + ALES) не реализован — раскладка ` +
        "слога литерала вместе с полуслогом ALES ассемблером не проверена",
    );
  }
  const operand = operands[index]!;
  if (operand.kind !== "imm") throw new EncodingError(`«${entry.mnemonic}»: операнд ${index} не литерал`);
  return { index, value: operand.value };
}

/**
 * Поле ссылки на литерал — `opcodes/e2k-dis.c:445-479`:
 * `(v & 0xf8) == 0xd0` — 16-битный литерал (`lit_num = v & 3`, бит 2 = старшая половина слова),
 * `(v & 0xfc) == 0xd8` — 32-битный литерал, `(v & 0xfc) == 0xdc` — 64-битный.
 *
 * Наш кодировщик берёт **старшую половину** слова для 16-битного литерала (`0xd4`): именно так
 * поступает ассемблер МЦСТ (проверено: `movts,0 42, %b[1]` → поле `0xd4`, литерал в старшей
 * половине последнего слова).
 */
export const LITERAL_FIELD_F16 = 0xd4;
export const LITERAL_FIELD_F32 = 0xd8;
export const LITERAL_FIELD_F64 = 0xdc;

/** Собрать инструкцию с литеральным операндом: 16 байт, литерал — в последнем слове. */
/**
 * Собрать инструкцию с **64-битным** литералом: поле ссылки `0xdc`, два слова литерала.
 *
 * Порядок слов — **старшее первым** (`bytes[8..11]` — старшие 32 бита, `bytes[12..15]` — младшие):
 * так измерено ассемблером МЦСТ — `movtd,0 _f64 0x100000, %r8` даёт `00 00 00 00 00 00 10 00`, а
 * `0xdeadbeefcafebabe` — `ef be ad de be ba fe ca`. Форма выбирается **видом операнда** (`imm64`),
 * а не величиной значения: `0x100000` влезает в 32 бита, но как адрес требует 64.
 */
function encodeImm64(
  entry: RealOpcodeEntry,
  channel: number,
  operands: readonly Operand[],
  literalIndex: number,
  value: bigint,
): Uint8Array {
  if (value < -(1n << 63n) || value >= 1n << 64n) {
    throw new EncodingRefusedError(
      `«${entry.mnemonic}»: литерал ${value} не влезает в 64 бита (форма 0xdc несёт два LTS-слова; ` +
        "opcodes/e2k-dis.c:485, gas/config/tc-e2k.c:2006)",
    );
  }
  const bits = BigInt.asUintN(64, value);
  if (entry.form === "ALF11") {
    throw new EncodingRefusedError(
      `«${entry.mnemonic}»: 64-битный литерал в длинной форме (ALS + ALES) не реализован — ` +
        "слог литерала конкурирует за место с полуслогом ALES",
    );
  }
  const values: Record<string, number> = { src1: 0, src2: 0, dst: 0, pdst: 0 };
  entry.operands.forEach((slot, index) => {
    if (index === literalIndex) return;
    if (slot === "pdst") return;
    values[slot] = registerField(operands[index], slot, entry.mnemonic);
  });
  const literalSlot = entry.operands[literalIndex]!;
  values[literalSlot] = LITERAL_FIELD_F64;
  if (entry.form === "ALF2") values.src1 = ALES_OPCE_NONE;
  const bytes = new Uint8Array(REAL_LONG_FORM_SIZE);
  // HS: mdl = 1, lng = 1 (16 байт), присутствует слог ALS.
  writeWord(bytes, 0, ((1 << 4) | 1 | ((1 << channel) << HS.al.shift)) >>> 0);
  writeWord(bytes, 4, alsWord(entry, { src1: values.src1!, src2: values.src2!, dst: values.dst!, pdst: 0 }));
  writeWord(bytes, 8, Number(bits >> 32n) >>> 0);
  writeWord(bytes, 12, Number(bits & 0xffffffffn) >>> 0);
  return bytes;
}

function encodeWithLiteral(
  entry: RealOpcodeEntry,
  channel: number,
  operands: readonly Operand[],
  literal: LiteralOperand,
): Uint8Array {
  if (!Number.isInteger(literal.value)) {
    throw new EncodingError(`«${entry.mnemonic}»: литерал ${literal.value} — не целое`);
  }
  const fits16 = literal.value >= -32768 && literal.value <= 32767;
  const fits32 = literal.value >= -2147483648 && literal.value <= 2147483647;
  if (!fits16 && !fits32) {
    throw new EncodingRefusedError(
      `«${entry.mnemonic}»: литерал ${literal.value} не влезает в 32 бита; 64-битная форма (0xdc, ` +
        "два слова литералов) не реализована",
    );
  }
  const field = fits16 ? LITERAL_FIELD_F16 : LITERAL_FIELD_F32;
  // Поля регистров: литеральный операнд занимает поле своего слота, остальные — как обычно.
  const values: Record<string, number> = { src1: 0, src2: 0, dst: 0 };
  entry.operands.forEach((slot, index) => {
    if (index === literal.index) return;
    values[slot] = registerField(operands[index], slot, entry.mnemonic);
  });
  const literalSlot = entry.operands[literal.index]!;
  values[literalSlot] = field;
  // У ALF2 на месте src1 лежит расширение opce = NONE, а не регистр
  // (include/opcode/e2k.h:93); без этого байт 6 отличается от байтов ассемблера.
  if (entry.form === "ALF2") values.src1 = ALES_OPCE_NONE;
  // Проверяются только регистровые слоты: в слоте литерала лежит поле ссылки (0xd4/0xd8).
  // Верхняя граница — 0x80 | 63 (оконный файл): поле слота восьмибитное, 0xc0+ занято литералами.
  for (const slot of entry.operands) {
    if (slot === literalSlot || (entry.form === "ALF2" && slot === "src1")) continue;
    const value = values[slot]!;
    if (value > (REGISTER_FILE_WINDOW | REAL_MAX_REGISTER)) {
      throw new EncodingError(`«${entry.mnemonic}»: регистр ${value} вне 0..${REAL_MAX_REGISTER}`);
    }
  }
  const bytes = new Uint8Array(REAL_LONG_FORM_SIZE);
  // HS: mdl = 1, lng = 1 (16 байт), присутствует слог ALS.
  writeWord(bytes, 0, ((1 << 4) | 1 | ((1 << channel) << HS.al.shift)) >>> 0);
  writeWord(bytes, 4, alsWord(entry, { src1: values.src1!, src2: values.src2!, dst: values.dst!, pdst: 0 }));
  // Слово 2 — пустое; слово 3 — литерал (LTS читаются с конца: qemu/target/e2k/instr-bits.h:211-221).
  if (fits16) writeHalf(bytes, 14, literal.value & 0xffff);
  else writeWord(bytes, 12, literal.value >>> 0);
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
  // Слоги управления разбираются отдельно: у них нет слога ALS, зато есть SS и/или CS0/CS1.
  if (fieldOf(hs, HS.ss) !== 0 || fieldOf(hs, HS.cs) !== 0) return decodeControl(bytes, hs);
  // Поля, которых интерфейс не выражает, обязаны быть нулевыми. Поля `nop` здесь нет: у формы
  // ALF7 оно равно 2 (implicit_nops, gas/config/tc-e2k.c:5923) и сверяется с записью ниже.
  for (const [name, field] of [
    ["lm", HS.lm],
    ["x (бит 11)", HS.x],
    ["sw", HS.sw],
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
  // Четыре слова бывает и без полуслога ALES: тогда в последнем слове лежит литерал (LTS).
  const hasLiteralField = [readWord(bytes, 4) >>> 16, (readWord(bytes, 4) >>> 8) & 0xff, readWord(bytes, 4) & 0xff].some(
    (value) => value >= 0xd0 && value <= 0xdf,
  );
  if (long ? words !== 4 : !(words === 2 || (words === 4 && hasLiteralField))) {
    throw new EncodingError(
      `форма не сходится с длиной: полуслог ALES ${long ? "есть" : "нет"}, слов ${words}` +
        (hasLiteralField ? ", в слове литерал" : ""),
    );
  }
  if (!long && words === 4 && aleMask !== 0) {
    throw new EncodingRefusedError("НЕТ В ИСТОЧНИКЕ: полуслог ALES вместе с литералом не реализован");
  }

  const als = readWord(bytes, 4);
  if (((als >>> HS.speculative) & 1) !== 0) {
    throw new EncodingError("бит спекулятивного режима установлен, но интерфейс его не выражает");
  }
  const opc = (als >>> 24) & 0x7f;
  const src1 = (als >>> 16) & 0xff;
  const src2 = (als >>> 8) & 0xff;
  const dst = als & 0xff;
  // ALF7: младший байт слова ALF — это `cmpopce[7:5] | pdst[4:0]`, а не регистр-приёмник.
  const cmpOpce = (als >>> 5) & 0x7;
  const pdst = als & 0x1f;

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
      candidate.opc === opc &&
      (candidate.form === "ALF11") === long &&
      candidate.channels.includes(channel) &&
      // У трёх сравнений код операции один (0x20), различает их код условия `cmpopce[7:5]`.
      (candidate.form !== "ALF7" || candidate.cmpOpce === cmpOpce),
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
  // Поле nop берётся из формы: у сравнений ALF7 оно равно 2 (implicit_nops шаблона,
  // gas/config/tc-e2k.c:5923). Иначе это поле, которого интерфейс не выражает, — и подмена его
  // бита вернула бы ту же инструкцию.
  const nop = fieldOf(hs, HS.nop);
  const expectedNops = entry.implicitNops ?? 0;
  if (nop !== expectedNops) {
    throw new EncodingError(
      `поле nop = ${nop}, а форма ${entry.form} требует ${expectedNops} ` +
        `(implicit_nops записи — gas/config/tc-e2k.c:5923, ${entry.source})`,
    );
  }
  if (entry.form === "ALF2" && src1 !== ALES_OPCE_NONE) {
    throw new EncodingError(
      `«${entry.mnemonic}»: расширение opce = 0x${src1.toString(16)}, ожидалось 0x${ALES_OPCE_NONE.toString(16)} ` +
        "(NONE — include/opcode/e2k.h:93)",
    );
  }
  // Проверяются только те поля, которые форма действительно несёт: у ALF2 на месте src1 лежит
  // расширение opce, а не регистр; поле 0xd0..0xdf — литеральная ссылка, а не регистр
  // (opcodes/e2k-dis.c:445-504); у ALF7 приёмник — предикат, а не регистр (поле pdst[4:0]).
  for (const slot of entry.operands) {
    if (entry.form === "ALF2" && slot === "src1") continue;
    if (slot === "pdst") continue;
    const value = slot === "src1" ? src1 : slot === "src2" ? src2 : dst;
    if (value >= 0xd0 && value <= 0xdf) continue;
    // Верхняя граница — 0x80 | 63: старший бит поля означает оконный файл регистров
    // (opcodes/e2k-dis.c:416-419), 0xc0+ занято литералами и непосредственными значениями.
    if (value > (REGISTER_FILE_WINDOW | REAL_MAX_REGISTER)) {
      throw new EncodingError(`регистр ${value} не выражается полем слога (0..${REAL_MAX_REGISTER})`);
    }
  }
  const operands: Operand[] = entry.operands.map((slot) => {
    // Предикат-приёмник сравнения: номер — поле pdst[4:0], отдельный файл, а не регистр.
    if (slot === "pdst") return { kind: "pred" as const, index: pdst };
    const value = slot === "src1" ? src1 : slot === "src2" ? src2 : dst;
    // Литеральная ссылка: поле 0xd0..0xdf — это не регистр, а литерал
    // (opcodes/e2k-dis.c:445-504). Значение берётся из последнего слова.
    if (value >= 0xd0 && value <= 0xdf) {
      const litNum = value & 0x3;
      if (litNum !== 0) {
        throw new EncodingRefusedError(
          `НЕТ В ИСТОЧНИКЕ: литерал ссылается на слово LTS${litNum} (поле 0x${value.toString(16)}); ` +
            "реализовано одно слово литералов (LTS0)",
        );
      }
      if ((value & 0xf8) === 0xd0) {
        const shift = (value & 0x4) === 0 ? 0 : 16;
        const raw = (readHalf(bytes, 12 + shift / 8) << 0) & 0xffff;
        const signed = raw >= 0x8000 ? raw - 0x10000 : raw;
        return { kind: "imm" as const, value: signed };
      }
      if ((value & 0xfc) === 0xd8) return { kind: "imm" as const, value: readWord(bytes, 12) | 0 };
      if ((value & 0xfc) === 0xdc) {
        // 0xdc — 64-битный литерал: два LTS-слова, старшее первым (opcodes/e2k-dis.c:485,
        // gas/config/tc-e2k.c:2006). Порядок слов задан измеренной последовательностью.
        const high = readWord(bytes, 8) >>> 0;
        const low = readWord(bytes, 12) >>> 0;
        return { kind: "imm64" as const, value: (BigInt(high) << 32n) | BigInt(low) };
      }
      throw new EncodingRefusedError(
        `НЕТ В ИСТОЧНИКЕ: 64-битный литерал (поле 0x${value.toString(16)}) не реализован`,
      );
    }
    // Оконный файл регистров: поле 0x80..0xbf — это %r[N] (opcodes/e2k-dis.c:418-419).
    // Различие существенно: %b[0] и %r0 — разные ячейки (qemu/target/e2k/reg-index.h:79,117).
    if (value >= REGISTER_FILE_WINDOW && value <= 0xbf) {
      return { kind: "reg" as const, index: value & 0x3f, file: "window" as const };
    }
    return { kind: "reg" as const, index: value };
  });
  return { mnemonic: entry.mnemonic, channel, operands };
}

/**
 * Разбор инструкции управления: слоги SS, CS0 и CS1.
 *
 * Поля — из `qemu/target/e2k/syllab-format.h` (HS: `s[12]`, `c[15:14]`; SS: `ipd[31:30]`,
 * `ctop[11:10]`, `ctcond[8:0]`; CS0: `ctpr[31:30]`, `ctp_opc[29:28]`, `param/disp[27:0]`;
 * CS1: `opc[31:28]`, `param[27:0]`) и `opcodes/e2k-dis.c:1896-1911`, `:1584-1640`.
 */
function decodeControl(bytes: Uint8Array, hs: number): AsmInstruction {
  const ssPresent = fieldOf(hs, HS.ss) !== 0;
  const c0Present = (fieldOf(hs, HS.cs) & 0x1) !== 0;
  const c1Present = (fieldOf(hs, HS.cs) & 0x2) !== 0;
  // Команда с слогом ALS и слогом управления одновременно в этой реализации не разбирается:
  // смешанные команды не проверены ассемблером, а угадывать раскладку запрещено.
  if (fieldOf(hs, HS.al) !== 0 || fieldOf(hs, HS.ale) !== 0) {
    throw new EncodingRefusedError(
      "НЕТ В ИСТОЧНИКЕ: слог управления (SS/CS) вместе со слогом ALS в одной команде — " +
        "такая раскладка ассемблером не проверена",
    );
  }
  for (const [name, field] of [
    ["nop", HS.nop],
    ["lm", HS.lm],
    ["x (бит 11)", HS.x],
    ["sw", HS.sw],
    ["CDS", HS.cd],
    ["PLS", HS.pl],
  ] as const) {
    if (fieldOf(hs, field) !== 0) {
      throw new EncodingError(`поле ${name} = ${fieldOf(hs, field)} — разбор инструкции управления отвергнут`);
    }
  }
  // Раскладка: HS, затем SS (если есть), затем CS0 (если есть) и CS1 (если есть).
  let offset = 4;
  const ss = ssPresent ? readWord(bytes, offset) : 0;
  if (ssPresent) offset += 4;
  const cs0 = c0Present && !c1Present ? readWord(bytes, offset) : 0;
  if (c0Present && !c1Present) offset += 4;
  const cs1 = c1Present ? readWord(bytes, offset) : 0;

  if (c1Present && !ssPresent && !c0Present) {
    // setbn/setbp: одиночный слог CS1 (HS = `01 80 00 00`), opc = SETBR (4).
    if (bytes.length !== REAL_SHORT_FORM_SIZE) throw new EncodingError("setbn: ожидалась длина 8 байт");
    const opc = (cs1 >>> 28) & 0xf;
    if (opc !== 4) {
      throw new EncodingRefusedError(`НЕТ В ИСТОЧНИКЕ: CS1.opc = ${opc} без SS и CS0; реализован SETBN (4)`);
    }
    const setbn = ((cs1 >>> 26) & 0x1) === 1;
    const setbp = ((cs1 >>> 27) & 0x1) === 1;
    if (setbp) throw new EncodingRefusedError("НЕТ В ИСТОЧНИКЕ: setbp (бит 27) не реализован");
    if (!setbn) {
      throw new EncodingRefusedError("НЕТ В ИСТОЧНИКЕ: CS1.opc = 4 без бита setbn/setbp — не setbn");
    }
    return {
      mnemonic: "setbn",
      channel: 0,
      operands: [
        { kind: "imm", value: (cs1 >>> 6) & 0x3f },
        { kind: "imm", value: cs1 & 0x3f },
        { kind: "imm", value: (cs1 >>> 12) & 0x3f },
      ],
    };
  }

  if (c1Present) {
    if (!ssPresent || c0Present) throw new EncodingError("call: ожидались слоги SS и CS1");
    if (bytes.length !== REAL_LONG_FORM_SIZE) throw new EncodingError("call: ожидалась длина 16 байт");
    const opc = (cs1 >>> 28) & 0xf;
    if (opc !== 5) {
      throw new EncodingRefusedError(`НЕТ В ИСТОЧНИКЕ: CS1.opc = ${opc}; реализован только CALL (5)`);
    }
    const ctpr = ssCtrp(ss);
    const cond = ss & 0x1ff;
    if (cond !== CT_COND_ALWAYS) {
      throw new EncodingError(
        `call: код условия 0x${cond.toString(16)}, реализовано только «всегда» (0x${CT_COND_ALWAYS.toString(16)})`,
      );
    }
    if (readWord(bytes, 12) !== 0) throw new EncodingError("call: ненулевое слово выравнивания");
    return {
      mnemonic: "call",
      channel: 0,
      operands: [
        { kind: "imm", value: ctpr },
        { kind: "imm", value: cs1 & 0x0fffffff },
      ],
    };
  }

  if (c0Present) {
    const ctpr = (cs0 >>> 30) & 0x3;
    const ctpOpc = (cs0 >>> 28) & 0x3;
    if (ctpOpc === 3) {
      // RETURN: cs0_ops[3][3]
      if (ctpr !== 3) throw new EncodingError(`return: ctpr ${ctpr}, ожидался 3`);
      return { mnemonic: "return", channel: 0, operands: [{ kind: "imm", value: ctpr }] };
    }
    if (ctpOpc === 0) {
      // DISP (C0F2): disp[27:0] — знаковое поле (FIELD_SEX32, translate-ctp.c:74)
      return {
        mnemonic: "disp",
        channel: 0,
        operands: [
          { kind: "imm", value: ctpr },
          { kind: "imm", value: dispOf(cs0) },
        ],
      };
    }
    if (ctpOpc === 2) {
      // SDISP: cs0_ops[1..3][2] (`opcodes/e2k-dis.c:1899-1901`), смещение — младшие 5 бит
      // (`opcodes/e2k-dis.c:2006-2007`: печатается `cs0 & 0x1f`; `gas/config/tc-e2k.c:6054-6064`:
      // значение обязано быть 0..31, символ запрещён).
      return {
        mnemonic: "sdisp",
        channel: 0,
        operands: [
          { kind: "imm", value: ctpr },
          { kind: "imm", value: cs0 & 0x1f },
        ],
      };
    }
    throw new EncodingRefusedError(
      `НЕТ В ИСТОЧНИКЕ: CS0.ctp_opc = ${ctpOpc} при %ctpr${ctpr} (ibranch/ldisp/gettsd) не реализован`,
    );
  }

  if (!ssPresent) throw new EncodingRefusedError("НЕТ В ИСТОЧНИКЕ: ни SS, ни CS0, ни CS1");
  const ctpr = ssCtrp(ss);
  const cond = ss & 0x1ff;
  return {
    mnemonic: "ct",
    channel: 0,
    operands: [
      { kind: "imm", value: ctpr },
      { kind: "imm", value: cond },
    ],
  };
}

/** Номер `%ctpr` из слога SS (`ctop[11:10]`). */
function ssCtrp(ss: number): number {
  const ctop = (ss >>> 10) & 0x3;
  if (ctop < 1 || ctop > 3) {
    throw new EncodingRefusedError(`НЕТ В ИСТОЧНИКЕ: SS.ctop = ${ctop}; реализованы %ctpr1..%ctpr3`);
  }
  return ctop;
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
