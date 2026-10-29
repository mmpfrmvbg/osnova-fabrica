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
 *    (ALOPF11 — слог ALS + полуслог ALES) формы, по одной операции на команду, плюс слоги
 *    управления SS/CS0/CS1 (в том числе `setmas`, §3.29/§3.32). Команда с **несколькими
 *    слогами ALS сразу** и команда, где слог управления стоит **вместе** с операцией ALS,
 *    — **не реализована** и отвергается с названной причиной, а не кодируется наугад.
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

/**
 * Базовых (глобальных) регистров — **32**: `E2K_RF_GLOB_IDX_MAX = 32` (`qemu/target/e2k/cpu.h:90`).
 *
 * Поле слога шире файла (семь бит, `0x00-0x7f` — `opcodes/e2k-dis.c:416-419`), поэтому «выражается
 * полем» ещё не значит «существует». Измерено: `movts,0 0, %b[60]` в модели даёт исключение.
 */
export const BASE_REGISTER_COUNT = 32;

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
export type RealForm = "ALF1" | "ALF2" | "ALF3" | "ALF11" | "ALF7";

/**
 * Слот операнда в слоге. Порядок в `operands` — порядок операндов интерфейса (результат последним).
 *
 * `pdst` — **предикат**-приёмник сравнения (поле `pdst[4:0]` формы ALF7), а не регистр: в
 * `ARGS_*` записи таблицы его нет, он принадлежит форме.
 *
 * `psrc` — **предикат-источник**, ставящий ALU-команду под условие (`? [~]%predN`). В `operands`
 * записи таблицы он **не стоит**: поле живёт не в слоге ALS, а в отдельном слоге-условии (`CDS`,
 * формат `CDF1_RLP`), и потому операнд **необязательный** — форма принимает его только там, где
 * запись это объявила (`acceptsPsrc`). Смешивать его с `pdst` нельзя: `pdst` — куда пишется
 * результат, `psrc` — при каком условии команда исполняется.
 */
export type RealSlot = "src1" | "src2" | "src3" | "dst" | "pdst" | "psrc";

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
  /**
   * Форма принимает **необязательный** операнд `psrc` — предикат-источник, ставящий команду под
   * условие (`? %predN` / `? ~%predN`).
   *
   * Он **необязателен намеренно**: `cmpandesb,0 %b[1], %b[2], %pred0` — восемь байт без условия
   * (измерено), а тот же текст с `? %pred1` — шестнадцать байт со слогом-условием. Обе формы
   * принимает ассемблер МЦСТ, и обе кодирует эта реализация; требовать условие всегда значило бы
   * переписать байты уже проверенных форм.
   *
   * Условие живёт в **слоге `CDS`** (`HS.cd[1:0]` — сколько их), а не в `SS`: поле `SS.ctcond.psrc`
   * принадлежит передаче управления (`ct`). Измерено ассемблером: `cmpandesb,0 %b[1], %b[2], %pred0
   * ? %pred1` → `11 01 01 04 40 02 01 22 00 00 00 00 00 00 61 04`, где в последнем слове лежит
   * `CDF1_RLP` (`gas/config/tc-e2k.c` кладёт условие AL-команды в CDS; разбор —
   * `binutils-gdb/opcodes/e2k-dis.c:745-780`, печать `? %predN` — там же).
   */
  readonly acceptsPsrc?: boolean;
  /** Источник: файл:строка таблицы опкодов. */
  readonly source: string;
  /** Источник раскладки полей формы. */
  readonly formSource: string;
}

const ALF1_SOURCE = "qemu/target/e2k/syllab-format.h:39-41 (ALF1: dst[7:0], src2[15:8], src1[23:16])";
const ALF2_SOURCE = "qemu/target/e2k/syllab-format.h:43-45 (ALF2: dst[7:0], src2[15:8], opce[23:16])";
const ALF3_SOURCE = "qemu/target/e2k/syllab-format.h:47-49 (ALF3: src3[7:0], src2[15:8], src1[23:16])";
const ALF11_SOURCE = "qemu/target/e2k/syllab-format.h:85-91 (ALEF: opc2[15:8], opce[7:0])";
const ALF7_SOURCE =
  "qemu/target/e2k/syllab-format.h:59-63 (ALF7: src1[23:16], src2[15:8], cmpopce[7:5], pdst[4:0]); " +
  "opcodes/e2k-dis.c:846-1010 (ALOPF7 различается по битам 7:5 слова ALF)";

/** Все каналы: `{1, 1, 1, 1, 1, 1}` в таблице МЦСТ. */
const ALL_CHANNELS: readonly number[] = [0, 1, 2, 3, 4, 5];
/** Каналы длинной формы этих операций: `{1, 1, 0, 1, 1, 0}` в таблице МЦСТ — без 2 и 5. */
const LONG_CHANNELS: readonly number[] = [0, 1, 3, 4];
/** Каналы памяти: `ld*` — `{1, 0, 1, 1, 0, 1}`, `st*` — `{0, 0, 1, 0, 0, 1}` (`opcodes/e2k-opc.h:604-619`, `:969-984`). */
const LOAD_CHANNELS: readonly number[] = [0, 2, 3, 5];
const STORE_CHANNELS: readonly number[] = [2, 5];
/**
 * Каналы деления и остатка: `{0, 0, 0, 0, 0, 1}` — **только пятый**.
 *
 * Так в таблице МЦСТ у всех восьми форм (`opcodes/e2k-opc.h:39-74`), и это не мелочь: попытка положить
 * `sdivs` в другой канал — отказ, а не молчаливая запись бита. Руководство (§10.3.3) и язык ассемблера
 * говорят то же: канал пишется явно, пример — `sdivs,5 %g17, %g16, %g16`.
 */
const DIVISION_CHANNELS: readonly number[] = [5];

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
  // ── Деление и остаток: раздел 10.3.3 руководства МЦСТ, ALOPF1, канал ТОЛЬКО пятый ──────────────
  //
  // `UDIVX`/`SDIVX`/`UMODX`/`SMODX` — деление 64/32→32 (расширенное делимое), `*s`/`*d` — 32/32→32 и
  // 64/64→64. Остаток имеет знак делимого; нецелые частные отсекаются. Байты сверены с ассемблером
  // МЦСТ (`as-new -mcpu=elbrus-v5`, `.tmp/div-forms.ts`) и пришпилены в
  // `src/e2k/e2kDivisionForms.test.ts`.
  { mnemonic: "udivs", opc: 0x40, form: "ALF1", operands: ["src1", "src2", "dst"], argFormats: ["S", "S", "S"], argsSource: "opcodes/e2k-opc.h:59 (ARGS_SSS)", channels: DIVISION_CHANNELS, source: "opcodes/e2k-opc.h:59", formSource: ALF1_SOURCE },
  { mnemonic: "udivd", opc: 0x41, form: "ALF1", operands: ["src1", "src2", "dst"], argFormats: ["D", "D", "D"], argsSource: "opcodes/e2k-opc.h:64 (ARGS_DDD)", channels: DIVISION_CHANNELS, source: "opcodes/e2k-opc.h:64", formSource: ALF1_SOURCE },
  { mnemonic: "sdivs", opc: 0x42, form: "ALF1", operands: ["src1", "src2", "dst"], argFormats: ["S", "S", "S"], argsSource: "opcodes/e2k-opc.h:69 (ARGS_SSS)", channels: DIVISION_CHANNELS, source: "opcodes/e2k-opc.h:69", formSource: ALF1_SOURCE },
  { mnemonic: "sdivd", opc: 0x43, form: "ALF1", operands: ["src1", "src2", "dst"], argFormats: ["D", "D", "D"], argsSource: "opcodes/e2k-opc.h:74 (ARGS_DDD)", channels: DIVISION_CHANNELS, source: "opcodes/e2k-opc.h:74", formSource: ALF1_SOURCE },
  { mnemonic: "udivx", opc: 0x44, form: "ALF1", operands: ["src1", "src2", "dst"], argFormats: ["D", "S", "S"], argsSource: "opcodes/e2k-opc.h:39 (ARGS_DSS)", channels: DIVISION_CHANNELS, source: "opcodes/e2k-opc.h:39", formSource: ALF1_SOURCE },
  { mnemonic: "umodx", opc: 0x45, form: "ALF1", operands: ["src1", "src2", "dst"], argFormats: ["D", "S", "S"], argsSource: "opcodes/e2k-opc.h:44 (ARGS_DSS)", channels: DIVISION_CHANNELS, source: "opcodes/e2k-opc.h:44", formSource: ALF1_SOURCE },
  { mnemonic: "sdivx", opc: 0x46, form: "ALF1", operands: ["src1", "src2", "dst"], argFormats: ["D", "S", "S"], argsSource: "opcodes/e2k-opc.h:49 (ARGS_DSS)", channels: DIVISION_CHANNELS, source: "opcodes/e2k-opc.h:49", formSource: ALF1_SOURCE },
  { mnemonic: "smodx", opc: 0x47, form: "ALF1", operands: ["src1", "src2", "dst"], argFormats: ["D", "S", "S"], argsSource: "opcodes/e2k-opc.h:54 (ARGS_DSS)", channels: DIVISION_CHANNELS, source: "opcodes/e2k-opc.h:54", formSource: ALF1_SOURCE },
  { mnemonic: "scls", opc: 0x14, form: "ALF1", operands: ["src1", "src2", "dst"], argFormats: ["S", "S", "S"], argsSource: "opcodes/e2k-opc.h:159 (ARGS_SSS)", channels: ALL_CHANNELS, source: "opcodes/e2k-opc.h:159", formSource: ALF1_SOURCE },
  { mnemonic: "scld", opc: 0x15, form: "ALF1", operands: ["src1", "src2", "dst"], argFormats: ["D", "D", "D"], argsSource: "opcodes/e2k-opc.h:164 (ARGS_DDD)", channels: ALL_CHANNELS, source: "opcodes/e2k-opc.h:164", formSource: ALF1_SOURCE },
  { mnemonic: "shls", opc: 0x18, form: "ALF1", operands: ["src1", "src2", "dst"], argFormats: ["S", "S", "S"], argsSource: "opcodes/e2k-opc.h:139 (ARGS_SSS)", channels: ALL_CHANNELS, source: "opcodes/e2k-opc.h:139", formSource: ALF1_SOURCE },
  { mnemonic: "shrs", opc: 0x1a, form: "ALF1", operands: ["src1", "src2", "dst"], argFormats: ["S", "S", "S"], argsSource: "opcodes/e2k-opc.h:149 (ARGS_SSS)", channels: ALL_CHANNELS, source: "opcodes/e2k-opc.h:149", formSource: ALF1_SOURCE },
  { mnemonic: "sars", opc: 0x1c, form: "ALF1", operands: ["src1", "src2", "dst"], argFormats: ["S", "S", "S"], argsSource: "opcodes/e2k-opc.h:179 (ARGS_SSS)", channels: ALL_CHANNELS, source: "opcodes/e2k-opc.h:179", formSource: ALF1_SOURCE },
  // ALF2 — слог ALS, расширение в битах 23:16, операнды src2, dst.
  // Каналы — `{1, 1, 0, 1, 1, 0}` в таблице МЦСТ (без 2 и 5), как у длинной формы:
  // исправлено при сверке с ассемблером (`docs/e2k-external-as.md`).
  // `acceptsPsrc` у `movts`: предикат-условие `? [~]%predN` ассемблер МЦСТ принимает и у переноса
  // (это и есть материализация булева значения — `cmp*` пишет ТОЛЬКО предикат, значения в регистре
  // у сравнения нет). Измерено `as-new 2.41` (WSL, `/root/build-gas/gas/as-new`, 2026-10-29):
  //   `movts,0 1, %b[1] ? %pred0`    → `11 00 01 04 01 c1 c0 60 00 00 00 00 00 00 60 04` (16 байт)
  //   `movts,0 0, %b[1] ? ~%pred0`   → `11 00 01 04 01 c0 c0 60 00 00 00 00 00 00 e0 04` (16 байт)
  // то есть короткая непосредственная форма (`0xc1` = `0xc0 | 1`) живёт в слове ALS и **при**
  // слоге-условии: слово 2 нулевое, условие — в слове 3 (`CDS`, как у сравнений).
  { mnemonic: "movts", opc: 0x60, form: "ALF2", operands: ["src2", "dst"], argFormats: ["S", "S"], argsSource: "opcodes/e2k-opc.h:644 (ARGS_SS)", channels: LONG_CHANNELS, acceptsPsrc: true, source: "opcodes/e2k-opc.h:644", formSource: ALF2_SOURCE },
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
  { mnemonic: "cmplsb", opc: 0x20, form: "ALF7", operands: ["src1", "src2", "pdst"], argFormats: ["S", "S", "P"], argsSource: "opcodes/e2k-opc.h:1019 (ARGS_SS; приёмник — pdst формы ALF7)", channels: LONG_CHANNELS, acceptsPsrc: true, cmpOpce: 0x6, implicitNops: 2, source: "opcodes/e2k-opc.h:1019", formSource: ALF7_SOURCE },
  { mnemonic: "cmplesb", opc: 0x20, form: "ALF7", operands: ["src1", "src2", "pdst"], argFormats: ["S", "S", "P"], argsSource: "opcodes/e2k-opc.h:1024 (ARGS_SS; приёмник — pdst формы ALF7)", channels: LONG_CHANNELS, acceptsPsrc: true, cmpOpce: 0x7, implicitNops: 2, source: "opcodes/e2k-opc.h:1024", formSource: ALF7_SOURCE },
  { mnemonic: "cmpesb", opc: 0x20, form: "ALF7", operands: ["src1", "src2", "pdst"], argFormats: ["S", "S", "P"], argsSource: "opcodes/e2k-opc.h:999 (ARGS_SS; приёмник — pdst формы ALF7)", channels: LONG_CHANNELS, acceptsPsrc: true, cmpOpce: 0x2, implicitNops: 2, source: "opcodes/e2k-opc.h:999", formSource: ALF7_SOURCE },
  // ── CMPAND* — СЛИТАЯ ФОРМА: логическое И источников, затем сравнение ────────────────────────
  //
  // **Это ТА ЖЕ форма ALF7, а не отдельная раскладка слога.** Семейство отличается только кодом
  // операции: `0x22` — одиночные источники (`ARGS_SS`), `0x23` — двойные (`ARGS_DD`); условие
  // сравнения по-прежнему в `cmpopce[7:5]`, приёмник — `pdst[4:0]`. Измерено ассемблером МЦСТ
  // (`as-new -mcpu=elbrus-v5`):
  //
  // ```
  // cmpesb,0    %b[1], %b[2], %pred0  →  01 01 00 04 40 02 01 20
  // cmpandesb,0 %b[1], %b[2], %pred0  →  01 01 00 04 40 02 01 22
  // ```
  //
  // Восемь байт, **без управляющего слога**: байт кода операции — единственное отличие от
  // `cmp*` с тем же условием. Это и есть замер, отменяющий чтение §3.25 реестра долга о
  // «предикате-источнике из SS»: источник «И» у CMPAND — **второй регистровый операнд**, а не
  // предикат (`qemu/target/e2k/tcg/translate-al-c2.c:683-720`: `res = zf = (src1 & src2) == 0`).
  //
  // **Набор условий усечён**: таблица МЦСТ даёт для CMPAND только `2` (равно), `4` (знак),
  // `5` (чётность) и `7` (меньше-или-равно) — условий `0`, `1`, `3` там `UNDEF`, а «меньше» (`6`)
  // в семействе **отсутствует вовсе** (`qemu/target/e2k/opcode-tables.c:1320-1341`). Поэтому
  // `cmplsb` слитой формы не имеет: замена пары возможна для `cmpesb`/`cmplesb`, но не для `cmplsb`.
  { mnemonic: "cmpandesb", opc: 0x22, form: "ALF7", operands: ["src1", "src2", "pdst"], argFormats: ["S", "S", "P"], argsSource: "opcodes/e2k-opc.h:1069 (ARGS_SS; приёмник — pdst формы ALF7)", channels: LONG_CHANNELS, acceptsPsrc: true, cmpOpce: 0x2, implicitNops: 2, source: "opcodes/e2k-opc.h:1069", formSource: ALF7_SOURCE },
  { mnemonic: "cmpandssb", opc: 0x22, form: "ALF7", operands: ["src1", "src2", "pdst"], argFormats: ["S", "S", "P"], argsSource: "opcodes/e2k-opc.h:1074 (ARGS_SS; приёмник — pdst формы ALF7)", channels: LONG_CHANNELS, acceptsPsrc: true, cmpOpce: 0x4, implicitNops: 2, source: "opcodes/e2k-opc.h:1074", formSource: ALF7_SOURCE },
  { mnemonic: "cmpandpsb", opc: 0x22, form: "ALF7", operands: ["src1", "src2", "pdst"], argFormats: ["S", "S", "P"], argsSource: "opcodes/e2k-opc.h:1079 (ARGS_SS; приёмник — pdst формы ALF7)", channels: LONG_CHANNELS, acceptsPsrc: true, cmpOpce: 0x5, implicitNops: 2, source: "opcodes/e2k-opc.h:1079", formSource: ALF7_SOURCE },
  { mnemonic: "cmpandlesb", opc: 0x22, form: "ALF7", operands: ["src1", "src2", "pdst"], argFormats: ["S", "S", "P"], argsSource: "opcodes/e2k-opc.h:1084 (ARGS_SS; приёмник — pdst формы ALF7)", channels: LONG_CHANNELS, acceptsPsrc: true, cmpOpce: 0x7, implicitNops: 2, source: "opcodes/e2k-opc.h:1084", formSource: ALF7_SOURCE },
  { mnemonic: "cmpandedb", opc: 0x23, form: "ALF7", operands: ["src1", "src2", "pdst"], argFormats: ["D", "D", "P"], argsSource: "opcodes/e2k-opc.h:1089 (ARGS_DD; приёмник — pdst формы ALF7)", channels: LONG_CHANNELS, acceptsPsrc: true, cmpOpce: 0x2, implicitNops: 2, source: "opcodes/e2k-opc.h:1089", formSource: ALF7_SOURCE },
  { mnemonic: "cmpandsdb", opc: 0x23, form: "ALF7", operands: ["src1", "src2", "pdst"], argFormats: ["D", "D", "P"], argsSource: "opcodes/e2k-opc.h:1094 (ARGS_DD; приёмник — pdst формы ALF7)", channels: LONG_CHANNELS, acceptsPsrc: true, cmpOpce: 0x4, implicitNops: 2, source: "opcodes/e2k-opc.h:1094", formSource: ALF7_SOURCE },
  { mnemonic: "cmpandpdb", opc: 0x23, form: "ALF7", operands: ["src1", "src2", "pdst"], argFormats: ["D", "D", "P"], argsSource: "opcodes/e2k-opc.h:1099 (ARGS_DD; приёмник — pdst формы ALF7)", channels: LONG_CHANNELS, acceptsPsrc: true, cmpOpce: 0x5, implicitNops: 2, source: "opcodes/e2k-opc.h:1099", formSource: ALF7_SOURCE },
  { mnemonic: "cmpandledb", opc: 0x23, form: "ALF7", operands: ["src1", "src2", "pdst"], argFormats: ["D", "D", "P"], argsSource: "opcodes/e2k-opc.h:1104 (ARGS_DD; приёмник — pdst формы ALF7)", channels: LONG_CHANNELS, acceptsPsrc: true, cmpOpce: 0x7, implicitNops: 2, source: "opcodes/e2k-opc.h:1104", formSource: ALF7_SOURCE },
  // ── ПАМЯТЬ (`ld*`/`st*`) ────────────────────────────────────────────────────────────────────
  //
  // Адрес — **сумма двух регистров**: `src1 + src2` (`qemu/target/e2k/tcg/translate-al-c11.c:26-34`,
  // `calc_addr_LD_ST`; её же ставит `prep_LD`/`prep_ST` — `:65-95`). Ни поля смещения, ни
  // масштабирования в самой команде нет: индекс обязан быть домножен программно.
  //
  // **Порядок операндов — текстовый, а не придуманный.** У `ld*` текст ассемблера идёт
  // `(src1, src2, приёмник)`, у `st*` — `(значение, база, смещение)` = `(src3, src1, src2)`:
  // измерено `as-new -mcpu=elbrus-v5` (`.tmp/std-order.ts`); поэтому слоты стоят в этом порядке,
  // и общая сборка ассемблерного текста (`registerText`) даёт верную строку без исключений.
  { mnemonic: "ldb", opc: 0x64, form: "ALF1", operands: ["src1", "src2", "dst"], argFormats: ["D", "D", "D"], argsSource: "opcodes/e2k-opc.h:604 (ARGS_DDD)", channels: LOAD_CHANNELS, source: "opcodes/e2k-opc.h:604", formSource: ALF1_SOURCE },
  { mnemonic: "ldh", opc: 0x65, form: "ALF1", operands: ["src1", "src2", "dst"], argFormats: ["D", "D", "D"], argsSource: "opcodes/e2k-opc.h:609 (ARGS_DDD)", channels: LOAD_CHANNELS, source: "opcodes/e2k-opc.h:609", formSource: ALF1_SOURCE },
  { mnemonic: "ldw", opc: 0x66, form: "ALF1", operands: ["src1", "src2", "dst"], argFormats: ["D", "D", "D"], argsSource: "opcodes/e2k-opc.h:614 (ARGS_DDD)", channels: LOAD_CHANNELS, source: "opcodes/e2k-opc.h:614", formSource: ALF1_SOURCE },
  { mnemonic: "ldd", opc: 0x67, form: "ALF1", operands: ["src1", "src2", "dst"], argFormats: ["D", "D", "D"], argsSource: "opcodes/e2k-opc.h:619 (ARGS_DDD)", channels: LOAD_CHANNELS, source: "opcodes/e2k-opc.h:619", formSource: ALF1_SOURCE },
  { mnemonic: "stb", opc: 0x24, form: "ALF3", operands: ["src3", "src1", "src2"], argFormats: ["D", "D", "S"], argsSource: "opcodes/e2k-opc.h:969 (ARGS_DDS)", channels: STORE_CHANNELS, source: "opcodes/e2k-opc.h:969", formSource: ALF3_SOURCE },
  { mnemonic: "sth", opc: 0x25, form: "ALF3", operands: ["src3", "src1", "src2"], argFormats: ["D", "D", "S"], argsSource: "opcodes/e2k-opc.h:974 (ARGS_DDS)", channels: STORE_CHANNELS, source: "opcodes/e2k-opc.h:974", formSource: ALF3_SOURCE },
  { mnemonic: "stw", opc: 0x26, form: "ALF3", operands: ["src3", "src1", "src2"], argFormats: ["D", "D", "S"], argsSource: "opcodes/e2k-opc.h:979 (ARGS_DDS)", channels: STORE_CHANNELS, source: "opcodes/e2k-opc.h:979", formSource: ALF3_SOURCE },
  { mnemonic: "std", opc: 0x27, form: "ALF3", operands: ["src3", "src1", "src2"], argFormats: ["D", "D", "S"], argsSource: "opcodes/e2k-opc.h:984 (ARGS_DDS)", channels: STORE_CHANNELS, source: "opcodes/e2k-opc.h:984", formSource: ALF3_SOURCE },
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
  // У команды с предикатом-условием (`psrc`) длина не выражается одним слогом ALS: это 16 байт
  // (HS + ALS + слог-условие CDS). Широкая команда считает место по слотам ALS и полуслогам ALES,
  // слог-условия в этот счёт не входят — поэтому здесь названный отказ, а не неверный размер.
  if (instruction.operands.length !== entry.operands.length) {
    throw new EncodingRefusedError(
      "НЕТ В ИСТОЧНИКЕ: у команды есть предикат-условие (psrc) — её длина выражается не одним слогом ALS " +
        "(16 байт: HS + ALS + слог-условие CDS), а широкая команда считает место только по слотам ALS/ALES",
    );
  }
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
    "реализованы формы: короткая (слог ALS, 8 байт) — ALF1, ALF2 и ALF7 (сравнения `cmp*` с предикатом-приёмником `pdst` " +
    "и слитое семейство `cmpand*`: те же восемь байт ALF7 с кодом операции 0x22 (одиночные источники) и 0x23 (двойные), " +
    "логическое И источников выполняет сама команда), " +
    "и длинная (слог ALS + полуслог ALES, 16 байт) — ALF11; по одной операции на команду; " +
    "у ALF7-сравнений (включая `cmpand*`) есть необязательный операнд `psrc` — предикат-условие " +
    "`? [~]%predN`: он кодируется **слогом-условием** (`CDS`, формат `CDF1_RLP`, 16 байт; измерено " +
    "ассемблером МЦСТ: `cmpandesb … ? %pred1` → `11 01 01 04 40 02 01 22 00 00 00 00 00 00 61 04`), " +
    "а не полем `SS.ctcond.psrc` — то поле принадлежит передаче управления; " +
    "операции без слога ALS (AAS-адресация MOVAB…MOVAQ, управление ct/call/return) НЕ реализованы и отвергаются; " +
    "из слогов управления реализованы SS/CS0/CS1 и слог-условие CDS; PLS/LTS-слоги остаются невыразимыми; " +
    "поле instructionSize заявляет короткую форму — " +
    "длинная форма занимает 16 байт (REAL_LONG_FORM_SIZE), шлюз auditEncoder рассчитан на одну длину; " +
    "у сравнений ALF7 (включая `cmpand*`) поле `nop` заголовочного слога равно 2 (implicit_nops шаблона, gas/config/tc-e2k.c:5923), " +
    "и это воспроизводится, а не игнорируется; " +
    "байты `cmpand*` сверены с MCST-`as` и `objdump` (src/e2k/e2kCmpand.test.ts), остальные — по-прежнему нет: " +
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
  // Базовый (глобальный) файл — **32** регистра, а не 64: `E2K_RF_GLOB_IDX_MAX = 32`
  // (`qemu/target/e2k/cpu.h:90`). Поле слога шире файла, поэтому адрес, который «выражается полем»,
  // может не существовать: измерено — `movts,0 0, %b[60]` в модели даёт
  // «qemu: exception at IP = …», и прогон кончается статусом 9.
  // Оконный файл (`%rN`, поле `0x80 | N`) ограничен 64 (`E2K_RF_WIN_IDX_MAX`, `cpu.h:88`).
  if (registerFileOf(operand) !== "window" && operand.index >= BASE_REGISTER_COUNT) {
    throw new EncodingError(
      `«${mnemonic}»: базовых регистров ${BASE_REGISTER_COUNT} (E2K_RF_GLOB_IDX_MAX — qemu/target/e2k/cpu.h:90), ` +
        `%b[${String(operand.index)}] в модели не существует; для оконных регистров используйте %rN`,
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
): { src1: number; src2: number; src3: number; dst: number; pdst: number } {
  // Форма, принимающая `psrc`, допускает на один операнд больше: предикат-условие живёт не в
  // слоге ALS, а в отдельном слоге, и его поля разбирает `psrcOf`.
  const carrier = entry.operands.length;
  const allowed = entry.acceptsPsrc === true ? [carrier, carrier + 1] : [carrier];
  if (!allowed.includes(operands.length)) {
    throw new EncodingError(
      `«${entry.mnemonic}»: операндов ${operands.length}, форма ${entry.form} несёт ${entry.operands.length} ` +
        `(${entry.operands.join(", ")})${entry.acceptsPsrc === true ? " и необязательный psrc" : ""}`,
    );
  }
  let src1 = 0;
  let src2 = 0;
  let src3 = 0;
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
    else if (slot === "src3") src3 = value;
    else dst = value;
  });
  if (entry.form === "ALF2") {
    // У ALF2 на месте src1 лежит расширение opce: операнда src1 у операции нет.
    src1 = ALES_OPCE_NONE;
  }
  return { src1, src2, src3, dst, pdst };
}

/**
 * Предикат-условие команды (`psrc`) — необязательный операнд сразу за объявленными формой.
 *
 * `undefined` — условия нет, команда кодируется восемью байтами. Вид операнда проверяется, а не
 * приводится: подставить регистр вместо предиката значило бы записать в поле `pred[4:0]` чужое
 * число (там же биты 6:5 отличают `%predN` от `%pcntN`).
 */
function psrcOf(
  entry: RealOpcodeEntry,
  operands: readonly Operand[],
): { predicate: number; negated: boolean } | undefined {
  if (operands.length === entry.operands.length) return undefined;
  if (entry.acceptsPsrc !== true) {
    throw new EncodingError(
      `«${entry.mnemonic}»: форма не принимает предикат-условие (psrc) — операндов ${operands.length}, ` +
        `форма несёт ${entry.operands.length} (${entry.operands.join(", ")})`,
    );
  }
  const operand = operands[entry.operands.length];
  if (operand === undefined || operand.kind !== "pred") {
    throw new EncodingError(
      `«${entry.mnemonic}»: операнд psrc обязан быть предикатом (%predN), а не регистром — ` +
        "поле pred[4:0] слога-условия несёт ещё и признак %predN/%pcntN (CDS, CDF1_RLP)",
    );
  }
  if (!Number.isInteger(operand.index) || operand.index < 0 || operand.index >= PREDICATE_COUNT) {
    throw new EncodingError(
      `«${entry.mnemonic}»: предикат-условие ${String(operand.index)} не выражается полем pred[4:0] ` +
        `(0..${PREDICATE_COUNT - 1}; qemu/target/e2k/syllab-format.h:128)`,
    );
  }
  return { predicate: operand.index, negated: operand.negated === true };
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
  fields: { src1: number; src2: number; src3: number; dst: number; pdst: number },
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
  if (entry.form === "ALF3") {
    // ALF3: `src3[7:0]`, `src2[15:8]`, `src1[23:16]` — `qemu/target/e2k/syllab-format.h:47-49`.
    // Младший байт — не приёмник: у записи в память он несёт записываемое значение.
    return (
      ((entry.opc & 0x7f) << 24) | ((fields.src1 & 0xff) << 16) | ((fields.src2 & 0xff) << 8) | (fields.src3 & 0xff)
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
 *
 * `conditioned` — команда несёт **слог-условие** (`CDS`): тогда длина тоже 16 байт (`lng = 1`),
 * но полуслога `ALES` у неё **нет** — `ale` остаётся нулём, а единицей становится `cd[1:0]`
 * (измерено: `cmpandesb … ? %pred1` → HS `11 01 01 04` против `01 01 00 04` без условия).
 */
function headerWord(entry: RealOpcodeEntry, channel: number, long: boolean, conditioned = false): number {
  const mdl = 1; // HS + ALS = два 4-байтовых слога до «средней точки» (gas/config/tc-e2k.c:9366)
  const words = long ? REAL_LONG_FORM_SIZE / 4 : REAL_SHORT_FORM_SIZE / 4;
  const lng = words / 2 - 1; // gas/config/tc-e2k.c:9577
  let hs = ((lng & HS.lng.mask) << HS.lng.shift) | ((mdl & HS.mdl.mask) << HS.mdl.shift);
  hs |= ((entry.implicitNops ?? 0) & HS.nop.mask) << HS.nop.shift;
  hs |= ((1 << channel) & HS.al.mask) << HS.al.shift;
  if (long && !conditioned) hs |= ((1 << channel) & HS.ale.mask) << HS.ale.shift;
  // Слог-условий ровно один: поле `cd[1:0]` считает их, а не отмечает наличие.
  if (conditioned) hs |= (1 & HS.cd.mask) << HS.cd.shift;
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
  if (control !== undefined) {
    if (instruction.control !== undefined) {
      throw new EncodingError(
        `«${instruction.mnemonic}»: слог управления в широкой команде один — у команды управления своего управляющего слога быть не может`,
      );
    }
    return encodeControl(control, instruction);
  }
  const entry = BY_MNEMONIC.get(instruction.mnemonic);
  if (entry === undefined) throw new EncodingRefusedError(realRefusalReason(instruction.mnemonic));
  const channel = channelOf(entry, instruction.channel);
  // Пара «операция ALS + слоги SS/CS/LTS» — одна широкая команда (измерено, `.tmp/osnova-ss-lts-probe*.ts`).
  // Слог ALS берётся тем же разбором, что у одиночной команды (`wideAlsSlotOf` → `alsSyllableOf`),
  // а слоги SS/CS — `wideSyllablesOf`: второй раскладки нет.
  if (instruction.control !== undefined) {
    if (instruction.operands.some((operand) => operand.kind === "imm64")) {
      throw new EncodingRefusedError(
        `«${instruction.mnemonic}»: 64-битный литерал вместе с управляющим слогом в одной команде не ` +
          "реализован — форма 0xdc несёт ДВА слова LTS, и раскладка «ALS + два LTS + управляющий слог» " +
          "ассемблером МЦСТ не измерялась (измерено одно слово LTS, docs/hardware-debt.md §3.34)",
      );
    }
    return wideCommandBytes([wideAlsSlotOf(instruction)], wideSyllablesOf(instruction.control));
  }
  // Команда с предикатом-условием (`psrc`) — отдельная ветвь: она длиннее (16 байт) и несёт слог
  // `CDS`, которого нет ни у короткой формы, ни у длинной (там на его месте полуслог `ALES`).
  const condition = psrcOf(entry, instruction.operands);
  if (condition !== undefined) {
    const bytes = new Uint8Array(REAL_LONG_FORM_SIZE);
    writeWord(bytes, 0, headerWord(entry, channel, true, true));
    // Полуслог у команды с условием занят слогом `CDS`, поэтому литерального слова (`LTS`) места не
    // имеет: допустима ровно короткая непосредственная форма — значение 0…15 в самом поле ALS
    // (измерено: `movts,0 1, %b[1] ? %pred0` → `01 c1 c0 60` в слове ALS). Литерал 16+ бит и
    // 64-битный литерал при условии — названный отказ, а не догадка о раскладке (LTS + CDS
    // ассемблером не измерялись).
    const literal = literalOperand(entry, instruction.operands);
    if (literal !== undefined) {
      if (!isShortImmediate(literal.value, entry.form)) {
        throw new EncodingRefusedError(
          `«${entry.mnemonic}»: литерал ${String(literal.value)} вместе с предикатом-условием (psrc) не ` +
            "реализован — у команды с условием место занимает слог `CDS`, и выразима только короткая " +
            `непосредственная форма (0…${String(IMM_SHORT_MAX)}); раскладка «LTS + CDS» ассемблером МЦСТ ` +
            "не измерялась",
        );
      }
      writeWord(bytes, 4, shortImmediateAlsWord(entry, instruction.operands, literal));
    } else {
      writeWord(bytes, 4, alsWord(entry, fieldsOf(entry, instruction.operands)));
    }
    // Слово 2 — литеральный слог LTS0; у gas он нулевой (измерено на четырёх каналах, CONDITION_SOURCE).
    writeWord(bytes, 12, conditionWord(channel, condition.predicate, condition.negated));
    return bytes;
  }
  // 64-битный литерал (`imm64`) кодируется формой 0xdc: два LTS-слова. Отдельная ветвь, потому
  // что значение — bigint, а короткие формы работают с number.
  const wide = instruction.operands.findIndex((operand) => operand.kind === "imm64");
  if (wide >= 0) {
    const literal = instruction.operands[wide];
    if (literal === undefined || literal.kind !== "imm64") throw new EncodingError("ожидался 64-битный литерал");
    return encodeImm64(entry, channel, instruction.operands, wide, literal.value);
  }
  const literal = literalOperand(entry, instruction.operands);
  if (literal !== undefined) {
    // Значение 0…15 ассемблер МЦСТ кладёт короткой непосредственной формой — 8 байт вместо 16.
    // Измерено: `movts,0 5, %b[1]` → `01 00 00 04 01 c5 c0 60`; при 16 он сам берёт литерал.
    if (isShortImmediate(literal.value, entry.form)) return encodeShortImm(entry, channel, instruction.operands, literal);
    return encodeWithLiteral(entry, channel, instruction.operands, literal);
  }
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
export type RealControlSlot =
  | "offset"
  | "receiver"
  | "channel"
  | "ctpr"
  | "cond"
  | "disp"
  | "sdisp"
  | "wbs"
  | "rsz"
  | "rbs"
  | "rcur"
  | "wsz"
  | "dbl"
  | "mas0"
  | "mas2"
  | "mas3"
  | "mas5";

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
  readonly form:
    | "SS"
    | "CS0_DISP"
    | "CS0_SDISP"
    | "CS0_RETURN"
    | "CS1_SETBN"
    | "CS1_SETWD"
    | "CS1_SETMAS"
    | "CS1_CALL"
  | "ALOPF12_GETSP";
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
/**
 * Источник формы `getsp`. Раскладка полей — из дизассемблера МЦСТ (`opcodes/e2k-dis.c:944-951`,
 * ветвь `templ->alopf == ALOPF12`: именно там форма ALOPF12 разбирается на src1/src2/dst),
 * плюс замер ассемблером (§3.46.1). Байты сверены с обоими.
 */
const GETSP_SOURCE =
  "opcodes/e2k-dis.c:944-951 (ветвь ALOPF12: разбор src1/src2/dst); " +
  "измерено: `getsp,0 -16, %db[10]` → 11 00 10 04 0a d4 ec 58 00 00 c0 01 00 00 f0 ff (docs/hardware-debt.md §3.46.1)";

export const REAL_CONTROL_OPCODES: readonly RealControlEntry[] = [
  {
    mnemonic: "getsp",
    form: "ALOPF12_GETSP",
    operands: ["offset", "receiver"],
    size: 16,
    formSource: GETSP_SOURCE,
    source:
      "gas/config/tc-e2k.c:4254 (у GETSP нужен ALES, хотя форма ALOPF12 — комментарий самих авторов: " +
      "«It seems that GETSP needs ALES even though it is ALOPF2. We cannot understand why», " +
      "и условие `alf->opc == 0x58`); opcodes/e2k-opc.h:2504 " +
      "(`{\"getsp\", 0xff, parse_alf_args, NULL, ALOPF12, NO_MAS, 0x58, {1,0,0,0,0,0}, ARGS_SD, 0xec, 0xc0, 0x1}`); " +
      "qemu/target/e2k/tcg/translate-al-c12.c:90 (e2k_translate_prep_GETSP), :157 (e2k_translate_exec_GETSP). " +
      "§3.46.1 (измерено ассемблером МЦСТ, подтверждено его дизассемблером): «getsp,0 -16, %db[10]» → " +
      "11 00 10 04 0a d4 ec 58 00 00 c0 01 00 00 f0 ff. Поля: опкод 0x58 (байт 7), форма ALOPF12, 16 байт, " +
      "канал ТОЛЬКО 0, приёмник — базовый (0x0a = %db[10]) или оконный (0x8a), литерал 16…32767 формой d4 " +
      "(байты 5–6 = d4 ec), минус — выделить, плюс — вернуть, смещение кратно 16. " +
      "ЧЕГО ФОРМА НЕ ВЫРАЖАЕТ и потому ОТКАЗЫВАЕТ с причиной, а не подбирает байты: короткая форма " +
      "литерала (0…15) и форма d8 (≥ 32768) — образцов для них у нас нет.",
  },
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
    mnemonic: "setwd",
    form: "CS1_SETWD",
    operands: ["wsz", "dbl"],
    size: 16,
    formSource: CS1_SOURCE,
    source:
      "qemu/target/e2k/tcg/translate-misc.c:585-610 (размер окна берётся из литерала: " +
      "`FIELD_EX32(instr_decoded->lts[0], LTF1, wsz) << 4`); " +
      "qemu/target/e2k/tcg/translate-lookahead.c:645-663, :683-691 (setwd — это CS1 с opcode SETR0/SETR1 " +
      "и литералом: `win_geo.wd_size_q = wsz`); " +
      "qemu/target/e2k/syllab-format.h:150-160 (LTF1: immw[31:0], rpsz[16:12], wsz[11:5], nfx[3+1], dbl[3]); " +
      "qemu/target/e2k/opcode-tables.h:60-68 (CS1 opc: SETR0 = 0); " +
      "gas/config/tc-e2k.c:6257-6301 (имена параметров: setwd wsz=, nfx=, dbl=); " +
      "измерено ассемблером: `setwd wsz=16, nfx=0, dbl=0` → `11 80 00 00 00 00 00 00 00 00 00 00 00 02 00 00`",
  },
  {
    mnemonic: "setmas",
    form: "CS1_SETMAS",
    operands: ["mas0", "mas2", "mas3", "mas5"],
    size: 8,
    formSource: CS1_SOURCE,
    source:
      "qemu/target/e2k/syllab-format.h:107-110 (C1F1_PARAM: mas0[27:21], mas2[20:14], mas3[13:7], mas5[6:0]); " +
      "qemu/target/e2k/opcode-tables.h:66 (E2K_CS1_OPC_MAS = 6); " +
      "qemu/target/e2k/decoder.c:1009-1016 (слог CS1 с opc MAS: mas_valid и четыре значения по каналам 0/2/3/5); " +
      "opcodes/e2k-dis.c:2046-2056 (MAS_OPC = 6 в перечислении CS1), :2238-2241 (печать `mas 0x%x` — сырой 28-битный param), " +
      ":1325-1329 (`shift[chn] = {21, -1, 14, 7, -1, 0}` — те же поля для команды памяти); " +
      "gas/config/tc-e2k.c:3339-3395 (разбор `mas=` у команды памяти — единственная форма, которую знает ассемблер; " +
      "отдельной мнемоники `setmas` у него нет, измерено: `unknown instruction 'setmas'`); " +
      "измерено ассемблером МЦСТ (форма `mas=` у команды памяти, отдельной мнемоники у `as` нет): " +
      "`ldd,2 %db[1], %db[2], %db[3], mas=0x7` → слог `00 c0 01 60` (0x6001c000 = opc 6 | 7<<14), " +
      "`ldd,5 … mas=0x7` → `07 00 00 60`, `ldd,0 … mas=0x7` → `00 00 e0 60`, `ldd,3 … mas=0x7` → `80 03 00 60`, " +
      "`ldd,2 … mas=0x55` → `00 40 15 60`",
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

// ── СЛОГ-УСЛОВИЕ ALU-КОМАНДЫ (CDS, формат CDF1_RLP) ───────────────────────────
//
// Условие `? [~]%predN` у **ALU**-команды лежит не в `SS` (там `ctcond` передачи управления),
// а в слоге `CDS` в **последнем** слове команды; их число считает поле `HS.cd[1:0]`
// (`binutils-gdb/opcodes/e2k-dis.c:257-262` — CDS берутся с конца, `:745-780` — разбор и печать).
//
// Раскладка 16-битной половины слога — `CDF1_RLP` (`qemu/target/e2k/syllab-format.h:125-128`):
// `opc[15:14]`, `mask[13:10]`, `neg[9:7]`, `pred[6:0]`. Значения полей — из разбора МЦСТ:
// `opc = 0` для каналов 0..2 и `1` для каналов 3..5 (`req_rlp`), `mask` и `neg` — это `1 << b`,
// где `b` — номер канала внутри своей тройки (`mask_bit = neg_bit = chn` для 0..2 и `chn - 3` для
// 3..5), а `pred[6:5] = 11` отличает `%predN` от `%pcntN`.
//
// **Всё измерено ассемблером МЦСТ** (`as-new -mcpu=elbrus-v5`), одна и та же команда с условием:
//
// | текст МЦСТ | последнее слово |
// |---|---|
// | `cmpandesb,0 %b[1], %b[2], %pred0 ? %pred1` | `00 00 61 04` |
// | `cmpandesb,1 …` | `00 00 65 08` |
// | `cmpandesb,3 …` | `00 00 65 44` |
// | `cmpandesb,4 …` | `00 00 65 48` |
// | `cmpandesb,0 … ? ~%pred1` | `00 00 e1 04` |

/** Источник полей слога-условия (`CDS`, формат `CDF1_RLP`). */
export const CONDITION_SOURCE =
  "qemu/target/e2k/syllab-format.h:125-128 (CDF1_RLP: opc[15:14], mask[13:10], neg[9:7], pred[6:0]); " +
  "binutils-gdb/opcodes/e2k-dis.c:696-730 (mask_bit = neg_bit = chn для каналов 0..2 и chn-3 для 3..5, " +
  "req_rlp = 0 и 1 соответственно), :745-780 (разбор и печать `? [~]%predN`); " +
  "измерено ассемблером МЦСТ (`as-new -mcpu=elbrus-v5`), байты — в шапке этого раздела";

/** Число слогов-условий, которое ставит эта реализация: поле `HS.cd[1:0]`. */
export const CONDITION_SYLLABLE_COUNT = 1;

/**
 * Признак «это `%predN`, а не `%pcntN`»: биты `pred[6:5]` равны `11`
 * (`binutils-gdb/opcodes/e2k-dis.c:771-775`).
 */
const CONDITION_PREDICATE_KIND = 0x60;

/** Поля слога-условия, прочитанные обратно из байтов. */
interface ConditionFields {
  readonly predicate: number;
  readonly negated: boolean;
}

/**
 * Слово слога `CDS` для условия `? [~]%predN` над каналом `channel`.
 *
 * Слово — 4 байта, но заполнена **старшая** половина: младшая у gas нулевая (измерено на всех
 * четырёх каналах выше). Значение вне полей — отказ, а не молчаливая запись бита.
 */
function conditionWord(channel: number, predicate: number, negated: boolean): number {
  if (!Number.isInteger(channel) || channel < 0 || channel >= REAL_CHANNELS) {
    throw new EncodingError(`условие: канал ${channel} вне ALU-каналов 0..${REAL_CHANNELS - 1}`);
  }
  if (!Number.isInteger(predicate) || predicate < 0 || predicate >= PREDICATE_COUNT) {
    throw new EncodingError(
      `условие: предикат ${String(predicate)} не выражается полем pred[4:0] (0..${PREDICATE_COUNT - 1})`,
    );
  }
  const lowAlc = channel <= 2;
  // Номер канала внутри своей тройки: бит разрешения и бит отрицания — один и тот же.
  const mask = 1 << (lowAlc ? channel : channel - 3);
  const half =
    ((lowAlc ? 0 : 1) << 14) |
    ((mask & 0xf) << 10) |
    (((negated ? mask : 0) & 0x7) << 7) |
    (CONDITION_PREDICATE_KIND | (predicate & 0x1f));
  return (half << 16) >>> 0;
}

/**
 * Прочитать слог-условие обратно. Отказывает там, где поле не выражает то, что эта реализация
 * пишет: чужой `opc`, непарный `mask`, `%pcntN` вместо `%predN`, отрицание не своей половины.
 */
function conditionOf(word: number, channel: number): ConditionFields {
  if ((word & 0xffff) !== 0) {
    throw new EncodingError(
      `слог-условие: младшая половина 0x${(word & 0xffff).toString(16)} не нулевая — ` +
        "газ кладёт условие только в старшую половину (измерено, CONDITION_SOURCE)",
    );
  }
  const half = (word >>> 16) & 0xffff;
  const opc = (half >>> 14) & 0x3;
  const mask = (half >>> 10) & 0xf;
  const neg = (half >>> 7) & 0x7;
  const pred = half & 0x7f;
  const lowAlc = channel <= 2;
  const expectedOpc = lowAlc ? 0 : 1;
  const expectedMask = 1 << (lowAlc ? channel : channel - 3);
  if (opc !== expectedOpc) {
    throw new EncodingRefusedError(
      `НЕТ В ИСТОЧНИКЕ: слог-условие с opc = ${opc} для канала ${channel} (ожидался ${expectedOpc}: ` +
        "req_rlp = 0 для ALC0..2 и 1 для ALC3..5, binutils-gdb/opcodes/e2k-dis.c:712,726)",
    );
  }
  if (mask !== expectedMask) {
    throw new EncodingRefusedError(
      `НЕТ В ИСТОЧНИКЕ: слог-условие с mask = 0x${mask.toString(16)} для канала ${channel} ` +
        `(ожидался 0x${expectedMask.toString(16)}); условий на несколько ALC эта реализация не пишет`,
    );
  }
  if ((pred & CONDITION_PREDICATE_KIND) !== CONDITION_PREDICATE_KIND) {
    throw new EncodingRefusedError(
      `НЕТ В ИСТОЧНИКЕ: слог-условие ссылается на 0x${pred.toString(16)} (биты 6:5 ≠ 11) — это ` +
        "%pcntN или мусор, а не %predN (binutils-gdb/opcodes/e2k-dis.c:771-775)",
    );
  }
  if (neg !== 0 && neg !== expectedMask) {
    throw new EncodingRefusedError(
      `НЕТ В ИСТОЧНИКЕ: отрицание 0x${neg.toString(16)} не совпадает с полем канала ` +
        `0x${expectedMask.toString(16)} (neg_bit = mask_bit, binutils-gdb/opcodes/e2k-dis.c:706-718)`,
    );
  }
  return { predicate: pred & 0x1f, negated: neg !== 0 };
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

/**
 * Слог CS1 команды `setmas`: `opc=6` (`E2K_CS1_OPC_MAS`), четыре семибитных значения по каналам
 * 0, 2, 3, 5 — `mas0[27:21]`, `mas2[20:14]`, `mas3[13:7]`, `mas5[6:0]`.
 *
 * Поля прочитаны в двух местах порта (декодер и формат слога) и **измерены ассемблером МЦСТ**:
 * у `as` отдельной мнемоники `setmas` нет, но форма `mas=` у команды памяти даёт тот же слог CS1,
 * и положение значения для каждого канала видно в байтах — `ldd,2 … mas=0x7` → `0x6001c000`
 * (7 << 14), `ldd,0 …` → `0x60e00000` (7 << 21), `ldd,3 …` → `0x60000380` (7 << 7),
 * `ldd,5 …` → `0x60000007` (7 << 0). То есть `opc = 6` и четыре поля — не наше предположение.
 *
 * Чего эта команда НЕ делает сама по себе: `mas` действует на команду памяти **той же широкой
 * команды** (`qemu/target/e2k/tcg/translate-mem.c:1081`: значение берётся из
 * `instr_decoded->mas[ch]`, а `mas_valid` сбрасывается на каждой команде — `decoder.c:41`).
 * Отдельная 8-байтовая команда `setmas` ничего последующему `ld` не задаёт.
 */
function cs1SetmasWord(mas0: number, mas2: number, mas3: number, mas5: number): number {
  const values: readonly (readonly [string, number])[] = [
    ["mas0", mas0],
    ["mas2", mas2],
    ["mas3", mas3],
    ["mas5", mas5],
  ];
  for (const [name, value] of values) {
    if (!Number.isInteger(value) || value < 0 || value > 0x7f) {
      throw new EncodingError(`setmas: ${name} = ${String(value)} вне 0..127 (поле 7 бит)`);
    }
  }
  return (((6 << 28) | (mas0 << 21) | (mas2 << 14) | (mas3 << 7) | mas5) >>> 0);
}

/** Числовые операнды команды управления по слотам формы — один разбор на все способы сборки. */
function controlValuesOf(entry: RealControlEntry, instruction: AsmInstruction): Map<RealControlSlot, number> {
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
  return values;
}

function encodeControl(entry: RealControlEntry, instruction: AsmInstruction): Uint8Array {
  const values = controlValuesOf(entry, instruction);
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
    case "ALOPF12_GETSP": {
      // ШАБЛОН — ИЗМЕРЕННЫЕ 16 байт (§3.46.1), а не собранные по полям: меняются только приёмник
      // (байт 4) и литерал (байты 14–15, дополнительный код). Всё остальное — как у ассемблера МЦСТ.
      const offset = values.get("offset")!;
      const receiver = values.get("receiver")!;
      if (offset === 0 || Math.abs(offset) < 16) {
        throw new EncodingError(
          "«getsp»: смещение " + String(offset) + " попадает в короткую форму литерала (0…15), " +
            "а её байты у нас НЕ измерены — образец есть только для формы d4 (16…32767). " +
            "Подбирать байты запрещено (§3.46.1, §3.68)",
        );
      }
      if (Math.abs(offset) >= 32768) {
        throw new EncodingError(
          "«getsp»: смещение " + String(offset) + " требует формы d8 (≥ 32768), её байты у нас НЕ измерены",
        );
      }
      if (offset % 16 !== 0) {
        throw new EncodingError(
          "«getsp»: смещение " + String(offset) + " не кратно 16, а выравнивание стека — 16 (§3.46.1)",
        );
      }
      if (instruction.channel !== 0) {
        throw new EncodingError("«getsp»: форма живёт ТОЛЬКО в канале 0 (§3.46.1)");
      }
      // байты 0–3: 11 00 10 04; байты 4–7: <приёмник> d4 ec 58; байты 8–11: 00 00 c0 01; 12–13: 00 00
      writeWord(bytes, 0, 0x04100011);
      const isWindow = (receiver & 0x80) !== 0;
      const register = receiver & 0x3f;
      if (receiver < 0 || receiver > 0xbf || (!isWindow && receiver > 0x3f) || (isWindow && register === 0)) {
        throw new EncodingError(
          "«getsp»: приёмник " +
            String(receiver) +
            " не выражается полем: базовый 0x00…0x3f, оконный 0x80…0xbf (двойное слово: 0x0a = %db[10], " +
            "0x8a = оконный %dr10) — §3.46.1",
        );
      }
      writeWord(bytes, 4, 0x58ecd40a | (receiver & 0xff));
      writeWord(bytes, 8, 0x01c00000);
      writeWord(bytes, 12, 0);
      const literal = offset & 0xffff;
      bytes[14] = literal & 0xff;
      bytes[15] = (literal >> 8) & 0xff;
      return bytes;
    }
    case "CS1_SETWD": {
      // HS: CS1 присутствует (бит 15), mdl = 1, lng = 1 → 16 байт (измерено: `11 80 00 00 …`).
      // Размер окна лежит в ЛИТЕРАЛЕ (LTS0 — последнее слово): `wsz[11:5]`, `dbl` — бит 3
      // (`qemu/target/e2k/syllab-format.h:150-160`); сам слог CS1 пуст, а его код операции —
      // `SETR0` (`qemu/target/e2k/opcode-tables.h:60`), потому что `setwd` — это SETR0 с литералом
      // (`qemu/target/e2k/tcg/translate-lookahead.c:645-652`).
      writeWord(bytes, 0, 0x00008011);
      writeWord(bytes, 4, 0);
      writeWord(bytes, 12, ((values.get("wsz")! & 0x7f) << 5) | ((values.get("dbl")! & 1) << 3));
      return bytes;
    }
    case "CS1_SETMAS": {
      // HS тот же, что у `setbn`: CS1 присутствует (бит 15), mdl = 1, lng = 0 → 8 байт.
      // У ассемблера МЦСТ отдельной мнемоники нет (проверено: «unknown instruction `setmas`»),
      // поэтому HS берётся из единственного измеренного образца CS1-без-ALS — `setbn`.
      writeWord(bytes, 0, 0x00008001);
      writeWord(
        bytes,
        4,
        cs1SetmasWord(values.get("mas0")!, values.get("mas2")!, values.get("mas3")!, values.get("mas5")!),
      );
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
// ШИРОКАЯ КОМАНДА «ОПЕРАЦИЯ ALS + УПРАВЛЯЮЩИЙ СЛОГ» — ИЗМЕРЕНО АССЕМБЛЕРОМ МЦСТ
// ─────────────────────────────────────────────────────────────────────────────
//
// До этого раздела кодировщик выпускал либо команду из одного слога ALS, либо команду из одних
// слогов управления: `mas` у команды памяти (`mas=` у `as`) и `write` вместе с арифметикой — это
// **одна** широкая команда с двумя слогами, а не две команды. Форма измерена
// `as-new -mcpu=elbrus-v5` (`.tmp/osnova-wide-control-probe.ts`):
//
// | текст МЦСТ | байты | HS: lng / mdl / al / cs |
// |---|---|---|
// | `ldw,2 %db[14], %db[12], %db[10]` | `01 00 00 10 0a 0c 0e 66` (8) | 0 / 1 / 4 / 0 |
// | `ldw,2 … , mas=0x7` | `12 80 00 10 0a 0c 0e 66 00 c0 01 60 00 00 00 00` (16) | 1 / 2 / 4 / 2 |
// | `{ adds,0 …; ldw,2 … mas=0x7 }` | `13 80 00 14 03 02 01 10 0a 0c 0e 66 00 c0 01 60` (16) | 1 / 3 / 5 / 2 |
// | `{ adds,0; adds,1; ldw,2 … mas=0x7 }` | `… 00 c0 01 60 00 00 00 00` (24) | 2 / 4 / 7 / 2 |
// | `{ muls,0 …; ldw,2 … mas=0x7 }` | `23 80 10 14 … 00 c0 01 60 00 00 c0 01 00 00 00 00` (24) | 2 / 3 / 5 / 2 |
//
// Отсюда три правила, которых у одиночной команды не было:
//
//   1. слог управления идёт **после** всех слогов ALS и **до** полуслогов ALES0/1/3/4 (последняя
//      строка таблицы: `muls` даёт ALES0 уже **за** слогом `mas`, а не перед ним);
//   2. `mdl` считает слова до средней точки **вместе** со слогом управления;
//   3. присутствие слога отмечает поле `cs` заголовочного слога (CS1 — бит 15), а не отдельное поле.

/** Сколько слогов ALS допускает форма: `E2K_ALS_NUM = 6` (`qemu/target/e2k/syllab-format.h:219`). */
export const E2K_ALS_NUM = 6;

/** Управляющий слог широкой команды: слово и его бит присутствия в поле `cs` заголовочного слога. */
export interface WideControlSyllable {
  readonly form: RealControlEntry["form"];
  /** Слово слога (4 байта). */
  readonly word: number;
  /** Значение поля `HS.cs`: CS0 — 1, CS1 — 2 (`qemu/target/e2k/syllab-format.h:24-25`). */
  readonly csBit: number;
}

/**
 * Слоги широкой команды, которые несёт не операция ALS: `SS`, `CS0`/`CS1` и `LTS`.
 *
 * Порядок **измерен** ассемблером МЦСТ 2026-09-27 (`.tmp/osnova-ss-lts-probe*.ts`), разбор —
 * `docs/hardware-debt.md` §3.34. Слова команды идут так:
 *
 * ```
 * HS, [SS], ALS…, [CS0|CS1], [ALES…], [добивка], [LTS]
 * ```
 *
 * | слог | где стоит | чем измерено |
 * |---|---|---|
 * | `SS` (`ct`, `call`) | **первым**, до слогов ALS | `{ adds,0; ct }` → `SS, ALS, 0` |
 * | `CS0`/`CS1` | после слогов ALS | `{ adds,0; sdisp }` → `ALS, CS0, 0` |
 * | `LTS` (литерал) | **последним**; добивка встаёт ПЕРЕД ним | `{ adds,0; movts,1 42 }` → `ALS, ALS, LTS` |
 */
export interface WideCommandSyllables {
  /** Слово слога `SS`. */
  readonly ss?: number;
  /** Слог `CS0`/`CS1`. */
  readonly cs?: WideControlSyllable;
}

/**
 * Разложить инструкцию управления в слоги **широкой команды**.
 *
 * Формы, годные в пару с операцией ALS, измерены ассемблером МЦСТ 2026-09-27
 * (`.tmp/osnova-ss-lts-probe.ts`, `.tmp/osnova-ss-lts-probe2.ts`, `.tmp/osnova-ss-lts-probe3.ts`;
 * разбор — `docs/hardware-debt.md` §3.34). До этого замера здесь стоял отказ: «порядок SS/LTS
 * относительно слогов ALS ассемблером не измерялся» — теперь измерен.
 *
 * | мнемоника | слоги | чем измерено |
 * |---|---|---|
 * | `ct %ctprN` | только `SS` (поле `cs` нулевое) | `{ adds,0 …; ct %ctpr1 }` → `SS, ALS, добивка` |
 * | `disp` / `sdisp %ctprN, K` | `CS0` | `{ adds,0 …; sdisp %ctpr1, 3 }` → `ALS, CS0` |
 * | `call %ctprN, wbs=W` | `SS` **и** `CS1` | `{ adds,0 …; call %ctpr1, wbs=4 }` → `SS, ALS, CS1` |
 * | `setbn`, `setmas` | `CS1` | §3.33 |
 *
 * Отказ назван там, где форма в пару не кладётся: `return` (измеренная форма несёт CS0 без ALS) и
 * `setwd` (его `wsz` живёт в литерале — раскладка «ALS + CS1 + LTS» для `setwd` не проверялась).
 */
export function wideSyllablesOf(instruction: AsmInstruction): WideCommandSyllables {
  const entry = realControlOpcode(instruction.mnemonic);
  if (entry === undefined) throw new EncodingRefusedError(realRefusalReason(instruction.mnemonic));
  const values = controlValuesOf(entry, instruction);
  switch (entry.form) {
    case "SS":
      // У `ct` слога управления нет вовсе: измерено `{ adds,0; ct %ctpr1 }` → HS с `cs = 0`, `ss = 1`.
      return { ss: ssWord(values.get("ctpr")!, values.get("cond")!) };
    case "CS0_DISP":
      return { cs: { form: entry.form, word: cs0DispWord(values.get("ctpr")!, values.get("disp")!), csBit: 1 } };
    case "CS0_SDISP":
      return { cs: { form: entry.form, word: cs0SdispWord(values.get("ctpr")!, values.get("sdisp")!), csBit: 1 } };
    case "CS1_SETBN":
      return {
        cs: {
          form: entry.form,
          word: cs1SetbnWord(values.get("rsz")!, values.get("rbs")!, values.get("rcur")!),
          csBit: 2,
        },
      };
    case "CS1_SETMAS":
      return {
        cs: {
          form: entry.form,
          word: cs1SetmasWord(values.get("mas0")!, values.get("mas2")!, values.get("mas3")!, values.get("mas5")!),
          csBit: 2,
        },
      };
    case "CS1_CALL":
      // `call` несёт ОБА слога сразу: измерено `{ adds,0 …; call %ctpr1, wbs=4 }` →
      // `13 90 00 04 | SS | ALS | CS1`, то есть `ss = 1` И `cs = 2` в одном HS.
      return {
        ss: ssWord(values.get("ctpr")!, CT_COND_ALWAYS),
        cs: { form: entry.form, word: cs1CallWord(values.get("wbs")!), csBit: 2 },
      };
    case "CS0_RETURN":
      throw new EncodingRefusedError(
        "«return»: в пару с операцией ALS не кладётся — измеренная форма `return %ctpr3` несёт CS0 " +
          "без слога ALS, а пара «ALS + return» ассемблером МЦСТ не проверялась",
      );
    case "CS1_SETWD":
      throw new EncodingRefusedError(
        "«setwd»: несёт литерал (`wsz` живёт в LTS0) — раскладка «ALS + CS1 + LTS» проверена для " +
          "литерала САМОЙ операции ALS, но не для `setwd` (docs/hardware-debt.md §3.34)",
      );
    default: {
      const unknown = entry as { form?: string };
      throw new EncodingRefusedError(`форма управления «${unknown.form}» в широкую команду не кладётся`);
    }
  }
}

/** Литеральный операнд слота широкой команды: значение и ширина. */
export interface WideSlotLiteral {
  readonly value: number;
  /** 32-битный литерал (`0xd8`) занимает слово `LTS` целиком; 16-битный — полуслог (`0xd0…0xd7`). */
  readonly wide32: boolean;
  /** Где в слове ALS лежит поле ссылки на литерал — сдвиг в битах (`src2` → 8). */
  readonly fieldShift: number;
}

/** Слот ALS широкой команды: канал, слово, полуслог ALES (форма ALF11) и литерал. */
export interface WideAlsSlot {
  readonly channel: number;
  /** Разрешённые каналы операции — по ним группировщик ищет свободный. */
  readonly channels: readonly number[];
  /**
   * Слово ALS. У слота с литералом поле ссылки **обнулено**: окончательное значение поля зависит от
   * места литерала среди слов `LTS`, а место выбирает раскладка команды
   * ({@link wideCommandBytes} → `placeLiterals`). Это то же решение, что в `as`: поле собирается
   * один раз, вместе с расстановкой (gas/config/tc-e2k.c:8360-8390, `encode_long_lit_in_src23`).
   */
  readonly als: number;
  readonly ales?: number;
  /** Литеральный операнд — если он у операции есть и **не** выражается короткой формой (0…15). */
  readonly literal?: WideSlotLiteral;
}

/**
 * Разложить инструкцию в слот широкой команды — **вместе с литералом**, если он у неё есть.
 *
 * Отличие от {@link alsSyllableOf} ровно одно: там литерал — названный отказ (у одиночной команды
 * своя ветвь кодирования), здесь он выражается слогом: литеральный (0…15 не помещается) —
 * словом `LTS`, которое `wideCommandBytes` кладёт последним, а **малый** (0…15) — короткой
 * непосредственной формой прямо в слове ALS, без `LTS`. Раскладка полей берётся из общих
 * {@link literalLayoutFor} и {@link shortImmediateAlsWord}, а не считается заново.
 *
 * Место литерала в словах `LTS` слот **не** выбирает: он называет значение и ширину, а расстановку
 * (номер слова от конца команды и полуслог) делает `placeLiterals` — иначе у двух литералов в одной
 * команде не было бы согласованного места (измерено 2026-09-27, `.tmp/osnova-two-lts-probe.ts`).
 */
export function wideAlsSlotOf(instruction: AsmInstruction): WideAlsSlot {
  const entry = BY_MNEMONIC.get(instruction.mnemonic);
  if (entry === undefined) throw new EncodingRefusedError(realRefusalReason(instruction.mnemonic));
  const literal = literalOperand(entry, instruction.operands);
  if (literal === undefined) {
    const syllable = alsSyllableOf(instruction);
    return {
      channel: syllable.channel,
      channels: syllable.channels,
      als: syllable.als,
      ...(syllable.ales === undefined ? {} : { ales: syllable.ales }),
    };
  }
  const channel = channelOf(entry, instruction.channel);
  // Малый литерал (0…15) — короткая непосредственная форма: поле `0xc0 | N` прямо в слог ALS,
  // слова `LTS` нет вовсе. Замерено 2026-09-27 (`.tmp/osnova-lts-short-probe.ts`): в широкой команде
  // `{ adds,0; movts,1 5 }` ассемблер даёт 16 байт БЕЗ `LTS`, и `mdl` считает этот слог обычным.
  // Без этой ветви 74 литерала из 78 в пяти ядрах кодировались бы не тем, что даёт `as`.
  if (isShortImmediate(literal.value, entry.form)) {
    return { channel, channels: entry.channels, als: shortImmediateAlsWord(entry, instruction.operands, literal) };
  }
  const layout = literalLayoutFor(entry, instruction.operands, literal);
  return {
    channel,
    channels: entry.channels,
    als: layout.als,
    literal: { value: layout.value, wide32: layout.wide32, fieldShift: layout.fieldShift },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// РАССТАНОВКА ЛИТЕРАЛОВ (LTS) В ШИРОКОЙ КОМАНДЕ
// ─────────────────────────────────────────────────────────────────────────────

/** Полуслог слова `LTS`; 32-битный литерал занимает слово целиком (`full`). */
type LtsHalf = "hi" | "lo";

/** Место литерала: номер слова `LTS` **от конца** команды (0 — последнее слово) и полуслог. */
interface LtsPlacement {
  readonly word: number;
  readonly half: LtsHalf | "full";
}

/** Заявка на литерал: индекс слота в команде, значение и ширина. */
interface LiteralRequest {
  readonly slot: number;
  readonly value: number;
  readonly wide32: boolean;
}

/**
 * Полуслоги слова `LTS` в порядке предпочтения — **измеренный** порядок ассемблера МЦСТ.
 *
 * `as` перебирает места литералов и берёт расстановку с наименьшей маской занятых полуслогов
 * (`gas/config/tc-e2k.c:8266-8345`, критерий `busy_lts`); при равных кандидатах годится первая
 * найденная. Список кандидатов 16-битного литерала — старший полуслог нулевого слова, затем
 * младший, затем то же у первого слова (`gas/config/tc-e2k.c:2257-2272`, таблица
 * `conv = {1, 0, 3, 2, …}`: «let one prefer the `hi` part for a 16-bit literal»), и он **ограничен
 * двумя словами** — дизассемблер МЦСТ называет `_f16s,_lts2/3` недопустимыми
 * (`opcodes/e2k-dis.c:462-466`: `if (lit_num > 1) … <illegal _f16s,_lts%d%s>`).
 */
const LTS_HALF_ORDER: readonly LtsPlacement[] = [
  { word: 0, half: "hi" },
  { word: 0, half: "lo" },
  { word: 1, half: "hi" },
  { word: 1, half: "lo" },
];

/** Сколько слов `LTS` допускает форма: `unsigned int lts[4]` (`opcodes/e2k-dis.c:59,289`). */
const LTS_WORD_LIMIT = 4;

/** Кандидаты места литерала: 32-битный занимает слово целиком, слова считаются от конца команды. */
function ltsCandidates(request: LiteralRequest): LtsPlacement[] {
  if (request.wide32) {
    return Array.from({ length: LTS_WORD_LIMIT }, (_, word): LtsPlacement => ({ word, half: "full" }));
  }
  return [...LTS_HALF_ORDER];
}

/** Маска занятых полуслогов: бит `2·слово` — старший полуслог, `2·слово + 1` — младший. */
function ltsMask(placement: LtsPlacement): number {
  if (placement.half === "full") return (1 << (placement.word * 2)) | (1 << (placement.word * 2 + 1));
  return 1 << (placement.word * 2 + (placement.half === "hi" ? 0 : 1));
}

/** Что уже лежит в слове `LTS`: 32-битный литерал целиком или 16-битные половинки. */
interface LtsWordState {
  wide?: number;
  hi?: number;
  lo?: number;
}

/** Значение полуслога слова — с учётом того, что 32-битный литерал занимает слово целиком. */
function ltsHalfValue(state: LtsWordState, half: LtsHalf): number | undefined {
  if (state.wide !== undefined) return half === "hi" ? (state.wide >>> 16) & 0xffff : state.wide & 0xffff;
  return state[half];
}

/**
 * Попытаться положить литерал: вернуть маску занятых полуслогов или `undefined`, если место занято
 * **другим** значением.
 *
 * Одинаковое значение переиспользует полуслог — так делает `as` (`hsyll_same_expr`,
 * `gas/config/tc-e2k.c:8225-8240`). Измерено 2026-09-27 (`.tmp/osnova-two-lts-probe.ts`):
 * `{ movts,0 42; movts,1 42 }` → оба поля `0xd4`, слово `0x002a0000` (одно слово на два слота),
 * `{ movts,0 _f32 0x100000; movts,1 _f32 0x100000 }` → оба поля `0xd8`, одно слово `0x00100000`.
 */
function placeLiteral(words: LtsWordState[], request: LiteralRequest, placement: LtsPlacement): number | undefined {
  const state = (words[placement.word] ??= {});
  if (request.wide32) {
    if (state.wide !== undefined && state.wide !== request.value) return undefined;
    for (const half of ["hi", "lo"] as const) {
      const existing = ltsHalfValue(state, half);
      const wanted = half === "hi" ? (request.value >>> 16) & 0xffff : request.value & 0xffff;
      if (existing !== undefined && existing !== wanted) return undefined;
    }
    state.wide = request.value >>> 0;
    state.hi = (request.value >>> 16) & 0xffff;
    state.lo = request.value & 0xffff;
    return ltsMask(placement);
  }
  const half = placement.half === "full" ? "lo" : placement.half;
  const existing = ltsHalfValue(state, half);
  if (existing !== undefined && existing !== request.value) return undefined;
  state[half] = request.value & 0xffff;
  return ltsMask(placement);
}

/**
 * Разложить литералы по словам `LTS`: **тот же перебор, что у `as`** — расстановка с наименьшей
 * маской занятых полуслогов, при равенстве первая найденная (`gas/config/tc-e2k.c:8266-8345`).
 *
 * Порядок разбора заявок — **сначала 32-битные, потом 16-битные** (`compare_literal_placements`
 * ставит впереди литералы большего размера, `gas/config/tc-e2k.c:8400-8430`), внутри одной ширины —
 * порядок слогов команды. Именно поэтому в измеренных формах 32-битный литерал оказывается в слове
 * `lts0`, а 16-битные — в освободившихся полуслогах слова `lts1`: `{ movts,0 42; movts,1 _f32 0x100000 }`
 * → поля `0xd5` и `0xd8`, слово литерала `0x00100000` последним, `0x002a0000` перед ним.
 */
function placeLiterals(requests: readonly LiteralRequest[]): {
  readonly placements: ReadonlyMap<number, LtsPlacement>;
  readonly wordCount: number;
} {
  if (requests.length === 0) return { placements: new Map(), wordCount: 0 };
  const ordered = [...requests.filter((request) => request.wide32), ...requests.filter((request) => !request.wide32)];
  const candidates = ordered.map((request) => ltsCandidates(request));
  const current = ordered.map(() => 0);
  let best: { readonly mask: number; readonly indexes: readonly number[] } | undefined;
  let firstIncrement = 0;
  for (;;) {
    const words: LtsWordState[] = [];
    let mask = 0;
    let index = 0;
    for (; index < ordered.length; index++) {
      const placed = placeLiteral(words, ordered[index]!, candidates[index]![current[index]!]!);
      if (placed === undefined) break;
      mask |= placed;
    }
    if (index === ordered.length) {
      firstIncrement = ordered.length - 1;
      if (best === undefined || mask < best.mask) best = { mask, indexes: [...current] };
    } else {
      firstIncrement = index;
    }
    for (let i = ordered.length - 1; i > firstIncrement; i--) current[i] = 0;
    let i = firstIncrement;
    for (; i >= 0; i--) {
      current[i] = current[i]! + 1;
      if (current[i]! < candidates[i]!.length) break;
      current[i] = 0;
    }
    if (i < 0) break;
    firstIncrement = i;
  }
  if (best === undefined) {
    throw new EncodingRefusedError(
      `литералов в одной широкой команде ${String(requests.length)} — в словах LTS места не хватает ` +
        `(полуслогов четыре в двух словах, слов ${String(LTS_WORD_LIMIT)}; у ` +
        '`as` тот же отказ: «literals cannot be packed into a wide command», gas/config/tc-e2k.c:8336)',
    );
  }
  const words: LtsWordState[] = [];
  const placements = new Map<number, LtsPlacement>();
  ordered.forEach((request, index) => {
    const placement = candidates[index]![best!.indexes[index]!]!;
    placeLiteral(words, request, placement);
    placements.set(request.slot, placement);
  });
  // Слова обязаны идти подряд от конца команды: пропуск слова — раскладка, ассемблером не измеренная.
  const distinct = [...new Set([...placements.values()].map((placement) => placement.word))].sort((a, b) => a - b);
  const wordCount = distinct.length === 0 ? 0 : distinct[distinct.length - 1]! + 1;
  if (distinct.some((word, index) => word !== index)) {
    throw new EncodingRefusedError(
      `раскладка литералов с пропуском слова LTS (заняты слова ${distinct.join(", ")}) не измерена: ` +
        "в измеренных формах слова литералов идут подряд от конца команды (docs/hardware-debt.md §3.34)",
    );
  }
  return { placements, wordCount };
}

/**
 * Байты широкой команды в **измеренном** порядке слогов:
 * `HS, [SS], ALS…, [CS0|CS1], [ALES…], [добивка], [LTS…]`.
 *
 * Один источник раскладки для обеих сторон: так собирает команду и одиночный кодировщик (пара
 * «ALS + слоги»), и группировщик (`src/e2k/widePacker.ts`, несколько слогов ALS). Второй реализации
 * раскладки быть не должно — расхождение между ними не поймал бы ни один оракул.
 *
 * Четыре правила, все измерены (`docs/hardware-debt.md` §3.34, `.tmp/osnova-two-lts-probe.ts`):
 *
 * 1. `SS` идёт **первым**, до слогов ALS (`{ adds,0; ct %ctpr1 }` → `SS, ALS, добивка`);
 * 2. `LTS` идёт **последним** (слова считаются от конца команды: `lts0` — последнее слово), а
 *    добивка до чётного числа 4-байтовых слогов встаёт **перед** словами литералов — поэтому
 *    наличие литерала меняет чётность: слов до литералов должно быть столько же по чётности,
 *    сколько слов `LTS` (1 слово → нечётно, 2 слова → чётно: `{ movts,0 42; movts,1 43 }` → без
 *    добивки, `{ movts,0 _f32 …; movts,1 43 }` → слово добивки перед литералами);
 * 3. `mdl` считает слоги до средней точки вместе с `SS` и слогом управления, но **без** ALES,
 *    добивки и слов `LTS`;
 * 4. **литералов в команде может быть несколько** — их места разбирает `placeLiterals` тем же
 *    перебором, что `as`, а поле ссылки вписывается в слово ALS уже здесь, потому что зависит от
 *    места.
 */
export function wideCommandBytes(
  slots: readonly WideAlsSlot[],
  syllables: WideCommandSyllables = {},
): Uint8Array {
  if (slots.length === 0) {
    throw new EncodingError(
      "широкая команда без слога ALS: команду из одного слога управления собирает encodeControl",
    );
  }
  if (slots.length > E2K_ALS_NUM) {
    throw new EncodingError(
      `слогов ALS ${slots.length} — форма допускает ${E2K_ALS_NUM} (E2K_ALS_NUM, qemu/target/e2k/syllab-format.h:219)`,
    );
  }
  const ordered = [...slots].sort((left, right) => left.channel - right.channel);
  if (new Set(ordered.map((slot) => slot.channel)).size !== ordered.length) {
    throw new EncodingError("две операции в один канал: ассемблер МЦСТ отказывает (gas/config/tc-e2k.c:8667-8668)");
  }
  // Литералы: место в словах `LTS` выбирает расстановка (у слота поле ссылки обнулено), затем поле
  // вписывается в слово ALS и собираются сами слова литералов — от конца команды.
  const requests: LiteralRequest[] = [];
  ordered.forEach((slot, index) => {
    if (slot.literal !== undefined) {
      requests.push({ slot: index, value: slot.literal.value, wide32: slot.literal.wide32 });
    }
  });
  const { placements, wordCount } = placeLiterals(requests);
  const ltsWords: number[] = Array.from({ length: wordCount }, () => 0);
  const alsWords = ordered.map((slot, index) => {
    const placement = placements.get(index);
    if (placement === undefined || slot.literal === undefined) return slot.als;
    const field = slot.literal.wide32
      ? LITERAL_FIELD_F32_BASE | placement.word
      : LITERAL_FIELD_F16_BASE | placement.word | (placement.half === "hi" ? 0x4 : 0);
    if (slot.literal.wide32) {
      ltsWords[placement.word] = slot.literal.value >>> 0;
    } else if (placement.half !== "full") {
      ltsWords[placement.word] =
        (ltsWords[placement.word]! | ((slot.literal.value & 0xffff) << (placement.half === "hi" ? 16 : 0))) >>> 0;
    }
    return (slot.als | ((field & 0xff) << slot.literal.fieldShift)) >>> 0;
  });
  const al = ordered.reduce((mask, slot) => mask | (1 << slot.channel), 0);
  const long = ordered.filter((slot) => slot.ales !== undefined);
  const ale = long.reduce((mask, slot) => mask | (1 << slot.channel), 0);

  const words: number[] = [0]; // HS: его поля считаются по числу слогов, поэтому заполняется в конце
  if (syllables.ss !== undefined) words.push(syllables.ss);
  for (const word of alsWords) words.push(word);
  if (syllables.cs !== undefined) words.push(syllables.cs.word);
  // «Средняя точка» — после HS, SS, слогов ALS и слога управления: полуслоги ALES0/1/3/4
  // начинаются со слова, на которое она указывает (`docs/e2k-wide-commands.md` §2.4).
  const middle = words.length;
  for (let index = 0; index < long.length; index += 2) {
    const first = long[index]!.ales!;
    const second = long[index + 1]?.ales ?? 0;
    words.push(((first & 0xffff) << 16) | (second & 0xffff));
  }
  // Добивка до чётного числа 4-байтовых слогов (`gas/config/tc-e2k.c:9488-9492`). Слова литералов
  // занимают конец команды и сами входят в этот счёт: измерено — с одним словом `LTS` число слов до
  // него обязано быть нечётным, с двумя чётным (`{ movts,0 42; movts,1 43 }` — 4 слова без добивки,
  // `{ movts,0 42; movts,1 _f32 0x100000 }` — 6 слов с добивкой).
  if ((words.length + ltsWords.length) % 2 !== 0) words.push(0);
  for (let index = ltsWords.length - 1; index >= 0; index--) words.push(ltsWords[index]!);

  const mdl = middle - 1;
  const lng = words.length / 2 - 1;
  const cs = syllables.cs?.csBit ?? 0;
  const ss = syllables.ss === undefined ? 0 : 1;
  words[0] =
    (((lng & HS.lng.mask) << HS.lng.shift) |
      ((mdl & HS.mdl.mask) << HS.mdl.shift) |
      ((al & HS.al.mask) << HS.al.shift) |
      ((ale & HS.ale.mask) << HS.ale.shift) |
      ((cs & HS.cs.mask) << HS.cs.shift) |
      ((ss & HS.ss.mask) << HS.ss.shift)) >>>
    0;

  const bytes = new Uint8Array(words.length * 4);
  words.forEach((word, index) => writeWord(bytes, index * 4, word));
  return bytes;
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

/**
 * База поля ссылки на **16-битный** литерал: `0xd0 | lit_num | (старший полуслог ? 4 : 0)`
 * (`opcodes/e2k-dis.c:462-479`: `lit_num = v & 3`, `shift = (v & 4) ? 16 : 0`), где `lit_num` —
 * номер слова `LTS` **от конца** команды. У одиночной команды слово одно и полуслог старший,
 * поэтому там поле — `0xd4` ({@link LITERAL_FIELD_F16}).
 */
export const LITERAL_FIELD_F16_BASE = 0xd0;

/** База поля ссылки на **32-битный** литерал: `0xd8 | lit_num` — слово `LTS` целиком. */
export const LITERAL_FIELD_F32_BASE = 0xd8;

/**
 * Сдвиг поля ссылки на литерал в слове ALS: раскладка ALF1/ALF2 — `opc[31:24] | src1[23:16] |
 * src2[15:8] | dst[7:0]` (`qemu/target/e2k/syllab-format.h:59-63`).
 *
 * Измерено: у `movts` (ALF2, операнды `src2`, `dst`) поле литерала стоит в `src2` —
 * `movts,0 42, %b[1]` → `01 d4 c0 60`. Другие слоты для литерала замером не подтверждены, поэтому
 * называются отказом, а не догадкой.
 */
function alsLiteralFieldShift(slot: RealSlot, mnemonic: string): number {
  if (slot === "src1") return 16;
  if (slot === "src2") return 8;
  if (slot === "dst") return 0;
  throw new EncodingRefusedError(
    `«${mnemonic}»: литерал в слоте ${slot} — поле ссылки живёт в src1/src2/dst, и раскладка этого ` +
      "слота ассемблером МЦСТ не измерялась",
  );
}

/** Раскладка литерала до выбора места: слово ALS с **обнулённым** полем ссылки, сдвиг поля, ширина. */
interface LiteralLayout {
  readonly als: number;
  readonly fieldShift: number;
  readonly value: number;
  readonly wide32: boolean;
}

/**
 * Разложить литеральный операнд: проверить ширину, собрать слово ALS **без** поля ссылки.
 *
 * Поле ссылки обнуляется намеренно: у одиночной команды оно известно сразу (`0xd4`/`0xd8` — слово
 * `LTS` одно), а в широкой команде зависит от места литерала среди слов `LTS`, и место выбирает
 * {@link wideCommandBytes}. Так раскладка полей остаётся **одной** на оба пути: слово собирает
 * `alsWord`, а вписывает поле тот, кто знает место.
 */
function literalLayoutFor(
  entry: RealOpcodeEntry,
  operands: readonly Operand[],
  literal: LiteralOperand,
): LiteralLayout {
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
  // Поля регистров: литеральный операнд занимает поле своего слота, остальные — как обычно.
  const values: Record<string, number> = { src1: 0, src2: 0, dst: 0 };
  entry.operands.forEach((slot, index) => {
    if (index === literal.index) return;
    values[slot] = registerField(operands[index], slot, entry.mnemonic);
  });
  const literalSlot = entry.operands[literal.index]!;
  values[literalSlot] = fits16 ? LITERAL_FIELD_F16 : LITERAL_FIELD_F32;
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
  const fieldShift = alsLiteralFieldShift(literalSlot, entry.mnemonic);
  const word = alsWord(entry, {
    src1: values.src1!,
    src2: values.src2!,
    src3: values.src3 ?? 0,
    dst: values.dst!,
    pdst: 0,
  });
  return {
    als: (word & ~(0xff << fieldShift)) >>> 0,
    fieldShift,
    value: literal.value,
    wide32: !fits16,
  };
}

/**
 * Раскладка команды с литеральным операндом: слово ALS и слово LTS.
 *
 * Случай **одного** слова `LTS` — тот, что у одиночной команды: место известно заранее (слово одно,
 * полуслог старший), поэтому поле ссылки вписывается здесь же. Многолитеральные раскладки идут
 * через {@link wideCommandBytes}.
 *
 * Литерал читается **с конца** команды (`qemu/target/e2k/instr-bits.h:211-221`): у 16-битного
 * занята старшая половина последнего слова, у 32-битного — слово целиком. Измерено ассемблером
 * МЦСТ: `movts,0 42, %b[1]` → последнее слово `00 00 2a 00`, `movts,0 _f32 0x100000, %b[1]` →
 * `00 00 10 00`.
 */
function literalLayoutOf(
  entry: RealOpcodeEntry,
  operands: readonly Operand[],
  literal: LiteralOperand,
): { readonly als: number; readonly lts: number } {
  const layout = literalLayoutFor(entry, operands, literal);
  const field = layout.wide32 ? LITERAL_FIELD_F32 : LITERAL_FIELD_F16;
  return {
    als: (layout.als | ((field & 0xff) << layout.fieldShift)) >>> 0,
    lts: layout.wide32 ? layout.value >>> 0 : (((layout.value & 0xffff) << 16) >>> 0),
  };
}

/**
 * Поле короткой непосредственной формы: `0xc0 | N` для N = 0…15.
 *
 * Измерено ассемблером МЦСТ: `movts,0 5, %b[1]` → `01 00 00 04 01 c5 c0 60` (8 байт), то есть
 * значение лежит в битах 15:8 второго слова как `0xc0 | N`. При `N = 16` ассемблер сам переходит
 * на литерал LTS (`11 00 00 04 01 d4 c0 60 …`), поэтому граница формы — **ровно 0…15**.
 */
export const IMM_SHORT_BASE = 0xc0;

/** Наибольшее значение, выразимое короткой непосредственной формой. */
export const IMM_SHORT_MAX = 15;

/**
 * Выразимо ли значение короткой непосредственной формой — **без литерала**.
 *
 * Применимо только к коротким формам ALS (`ALF1`, `ALF2`): у длинной формы (`ALF11`) слог литерала
 * конкурирует за место с полуслогом ALES, и раскладка отвергается (`literalOperand`).
 */
export function isShortImmediate(value: number, form: RealForm): boolean {
  return Number.isInteger(value) && value >= 0 && value <= IMM_SHORT_MAX && form !== "ALF11";
}

/**
 * Слово ALS короткой непосредственной формы: поле `0xc0 | N` в слоте литерала.
 *
 * **Одна раскладка на два пути** — одиночную короткую команду ({@link encodeShortImm}) и слог
 * широкой команды ({@link wideAlsSlotOf}): вторая реализация разошлась бы с первой, и расхождение
 * не поймал бы ни один оракул. Именно так и было до 2026-09-27: `wideAlsSlotOf` для **любого**
 * литерала давал слово `LTS`, тогда как малый литерал (0…15) ассемблер МЦСТ кладёт короткой формой —
 * **без** слова `LTS`. Замер (`.tmp/osnova-lts-short-probe.ts`, `as-new 2.41`):
 * `{ adds,0 %b[2], %b[3], %b[4]; movts,1 5, %b[1] }` → `12 00 00 0c 04 03 02 10 01 c5 c0 60 00 00 00 00`,
 * то есть слово литерала `0x60c0c501` (поле `0xc5` = `0xc0 | 5`) и 16 байт **без** `LTS`.
 */
function shortImmediateAlsWord(
  entry: RealOpcodeEntry,
  operands: readonly Operand[],
  literal: LiteralOperand,
): number {
  const values: Record<string, number> = { src1: 0, src2: 0, dst: 0 };
  entry.operands.forEach((slot, index) => {
    if (index === literal.index) return;
    values[slot] = registerField(operands[index], slot, entry.mnemonic);
  });
  const literalSlot = entry.operands[literal.index]!;
  values[literalSlot] = IMM_SHORT_BASE | literal.value;
  // У ALF2 на месте src1 лежит расширение opce = NONE (`include/opcode/e2k.h:93`) — как и у литерала.
  if (entry.form === "ALF2") values.src1 = ALES_OPCE_NONE;
  return alsWord(entry, {
    src1: values.src1!,
    src2: values.src2!,
    src3: values.src3 ?? 0,
    dst: values.dst!,
    pdst: 0,
  });
}

/**
 * Собрать инструкцию короткой непосредственной формы: **8 байт**, поле `0xc0 | N` в слоте литерала.
 *
 * Форма слова ALS — та же, что у литеральной (`alsWord`), меняется только поле слота и длина:
 * `lng = 0` (одно слово), тогда как литерал занимает `lng = 1` (два слова).
 */
function encodeShortImm(
  entry: RealOpcodeEntry,
  channel: number,
  operands: readonly Operand[],
  literal: LiteralOperand,
): Uint8Array {
  const bytes = new Uint8Array(REAL_SHORT_FORM_SIZE);
  writeWord(bytes, 0, headerWord(entry, channel, false));
  writeWord(bytes, 4, shortImmediateAlsWord(entry, operands, literal));
  return bytes;
}

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
  writeWord(bytes, 4, alsWord(entry, { src1: values.src1!, src2: values.src2!, src3: values.src3 ?? 0, dst: values.dst!, pdst: 0 }));
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
  const { als, lts } = literalLayoutOf(entry, operands, literal);
  const bytes = new Uint8Array(REAL_LONG_FORM_SIZE);
  // HS: mdl = 1, lng = 1 (16 байт), присутствует слог ALS.
  writeWord(bytes, 0, ((1 << 4) | 1 | ((1 << channel) << HS.al.shift)) >>> 0);
  writeWord(bytes, 4, als);
  // Слово 2 — пустое; слово 3 — литерал (LTS читаются с конца: qemu/target/e2k/instr-bits.h:211-221).
  writeWord(bytes, 12, lts);
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
  // Слог-условие (`CDS`) — поле заголовка, которое интерфейс теперь выражает предикатом `psrc`.
  // Их число считает `HS.cd[1:0]`; эта реализация пишет не больше одного на команду.
  const cdsCount = fieldOf(hs, HS.cd);
  if (cdsCount > CONDITION_SYLLABLE_COUNT) {
    throw new EncodingRefusedError(
      `НЕТ В ИСТОЧНИКЕ: слогов-условий ${cdsCount}; эта реализация ставит не больше одного ` +
        `(${CONDITION_SYLLABLE_COUNT}) — одной ALU-команде газ ставит условие одним слогом ` +
        "(binutils-gdb/opcodes/e2k-dis.c:257-262)",
    );
  }
  const conditioned = cdsCount === CONDITION_SYLLABLE_COUNT;
  // Поля, которых интерфейс не выражает, обязаны быть нулевыми. Поля `nop` здесь нет: у формы
  // ALF7 оно равно 2 (implicit_nops, gas/config/tc-e2k.c:5923) и сверяется с записью ниже.
  for (const [name, field] of [
    ["lm", HS.lm],
    ["x (бит 11)", HS.x],
    ["sw", HS.sw],
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
  if (conditioned && long) {
    throw new EncodingRefusedError(
      "НЕТ В ИСТОЧНИКЕ: слог-условие вместе с полуслогом ALES в одной команде не реализован " +
        "(у команды с условием длина 16 байт, но место занимает слог CDS, а не ALES)",
    );
  }
  const words = bytes.length / 4;
  // Четыре слова бывает и без полуслога ALES: тогда в последнем слове лежит литерал (LTS) либо
  // слог-условие (CDS).
  const hasLiteralField = [readWord(bytes, 4) >>> 16, (readWord(bytes, 4) >>> 8) & 0xff, readWord(bytes, 4) & 0xff].some(
    (value) => value >= 0xd0 && value <= 0xdf,
  );
  if (long ? words !== 4 : !(words === 2 || (words === 4 && (hasLiteralField || conditioned)))) {
    throw new EncodingError(
      `форма не сходится с длиной: полуслог ALES ${long ? "есть" : "нет"}, слов ${words}` +
        (hasLiteralField ? ", в слове литерал" : "") +
        (conditioned ? ", слог-условие" : ""),
    );
  }
  if (conditioned && words !== 4) {
    throw new EncodingError(`слог-условие требует 16 байт, а команда занимает ${bytes.length}`);
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
  // ALF3: младший байт — `src3` (у записи в память это записываемое значение), а не приёмник.
  const src3 = als & 0xff;
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
  // Слог-условие стоит в последнем слове; на месте слова 2 у газа нули (литеральный слог LTS0).
  // Проверка нужна: без неё подмена этих байтов вернула бы ту же инструкцию.
  if (conditioned && readWord(bytes, 8) !== 0) {
    throw new EncodingError(
      "слово 2 у команды с условием не нулевое: там ожидается литеральный слог LTS0, " +
        "а занятое поле интерфейс не выражает (измерено, CONDITION_SOURCE)",
    );
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
  // Слог-условие у формы, которая его не принимает, — это поле, которого интерфейс не выражает:
  // молча выбросить его значило бы вернуть другую инструкцию под тем же именем.
  if (conditioned && entry.acceptsPsrc !== true) {
    throw new EncodingRefusedError(
      `НЕТ В ИСТОЧНИКЕ: у «${entry.mnemonic}» слог-условие не объявлено (acceptsPsrc) — разбор отвергнут`,
    );
  }
  // Проверяются только те поля, которые форма действительно несёт: у ALF2 на месте src1 лежит
  // расширение opce, а не регистр; поле 0xd0..0xdf — литеральная ссылка, а не регистр
  // (opcodes/e2k-dis.c:445-504); у ALF7 приёмник — предикат, а не регистр (поле pdst[4:0]).
  for (const slot of entry.operands) {
    if (entry.form === "ALF2" && slot === "src1") continue;
    if (slot === "pdst") continue;
    const value = slot === "src1" ? src1 : slot === "src2" ? src2 : slot === "src3" ? src3 : dst;
    if (value >= 0xd0 && value <= 0xdf) continue;
    // Короткая непосредственная форма `0xc0 | N` — тоже НЕ регистр: значение 0…15 лежит в самом
    // поле, литерального слова у команды нет (измерено ассемблером МЦСТ, `encodeShortImm`).
    // Без этой строки проверка падала на первом же таком поле: «регистр 193» (0xc1) — и сквозной
    // прогон ядер умирал целиком вместо разбора операндов, который эту форму умеет.
    if (value >= IMM_SHORT_BASE && value <= IMM_SHORT_BASE + IMM_SHORT_MAX) continue;
    // Верхняя граница — 0x80 | 63: старший бит поля означает оконный файл регистров
    // (opcodes/e2k-dis.c:416-419), 0xc0+ занято литералами и непосредственными значениями.
    if (value > (REGISTER_FILE_WINDOW | REAL_MAX_REGISTER)) {
      throw new EncodingError(`регистр ${value} не выражается полем слога (0..${REAL_MAX_REGISTER})`);
    }
  }
  const operands: Operand[] = entry.operands.map((slot) => {
    // Предикат-приёмник сравнения: номер — поле pdst[4:0], отдельный файл, а не регистр.
    if (slot === "pdst") return { kind: "pred" as const, index: pdst };
    const value = slot === "src1" ? src1 : slot === "src2" ? src2 : slot === "src3" ? src3 : dst;
    // Короткая непосредственная форма: поле `0xc0 | N` — значение 0…15 **в самом поле**, без
    // литерального слова. Измерено ассемблером МЦСТ: `movts,0 5, %b[1]` → `01 00 00 04 01 c5 c0 60`
    // (8 байт, `lng = 0`). Слово литерала при этом быть не должно: `lng = 0` означает одно слово.
    if (value >= IMM_SHORT_BASE && value <= IMM_SHORT_BASE + IMM_SHORT_MAX) {
      // Два размера у этой формы, и оба измерены ассемблером МЦСТ: без условия — одно слово
      // (`movts,0 5, %b[1]` → 8 байт, `lng = 0`), с условием — 16 байт, где четвёртое слово занято
      // слогом `CDS` (`movts,0 1, %b[1] ? %pred0` → `01 c1 c0 60` в слове ALS, 2026-10-29).
      if (bytes.length !== REAL_SHORT_FORM_SIZE && !conditioned) {
        throw new EncodingError(
          `короткая непосредственная форма (поле 0x${value.toString(16)}) в команде ${bytes.length} байт: ` +
            "она выражается одним словом (lng = 0), литерального слова у неё нет",
        );
      }
      return { kind: "imm" as const, value: value - IMM_SHORT_BASE };
    }
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
  // Предикат-условие — последним операндом: он не в слоге ALS, поэтому и стоит за объявленными
  // формой. Отрицание восстанавливается из бита `neg[9:7]` и обязано быть сверено (`sameInstruction`).
  if (conditioned) {
    const condition = conditionOf(readWord(bytes, 12), channel);
    operands.push({
      kind: "pred" as const,
      index: condition.predicate,
      ...(condition.negated ? { negated: true } : {}),
    });
  }
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
