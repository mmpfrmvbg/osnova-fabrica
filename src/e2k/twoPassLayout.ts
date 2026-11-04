/**
 * ДВУХПРОХОДНАЯ РАСКЛАДКА: СНАЧАЛА АДРЕСА, ПОТОМ СМЕЩЕНИЯ.
 *
 * # Почему одного прохода мало
 *
 * Смещение перехода `disp` в e2k отсчитывается **от адреса команды до адреса цели**:
 *
 * ```
 * qemu/target/e2k/tcg/translate-ctp.c:74-75
 *   const int64_t disp = FIELD_SEX32(instr_decoded->cs0, C0F2, disp);
 *   const uint64_t new_base = (dc->instr_state.ip + (disp << 3ull)) & IP_MASK;
 * ```
 *
 * `instr_state.ip` — адрес **самой** инструкции, несущей слог CS0
 * (`qemu/target/e2k/tcg/translate-wi.c:414`: `dc->instr_state.ip = dc->ip_next`, то есть до
 * прибавления длины). Значит `disp = (адрес цели − адрес команды) / 8`, и посчитать его можно
 * только тогда, когда адрес цели известен, — а адрес цели зависит от размеров **всех**
 * разложенных до неё команд. Отсюда два прохода:
 *
 * | проход | что делает | чем размер |
 * |---|---|---|
 * | {@link firstPass} | каждой инструкции с формой — адрес в байтах | {@link CARRIER_FORMS} |
 * | {@link secondPass} | для `IR.jmp` — смещение в 8-байтных единицах | адреса первого прохода |
 *
 * Оба прохода **чистые**: ни один из них не кодирует байты, поэтому раскладку можно проверить
 * арифметикой, а не сравнением с самой собой.
 *
 * # Размер — из таблицы форм, а не из головы
 *
 * Команда e2k занимает 8 или 16 байт (`qemu/target/e2k/instr-bits.h:41-45`; кратность восьми
 * проверяется разбором — `src/e2k/e2k-real.ts`). В {@link CARRIER_FORMS} у каждой команды
 * назван **источник размера**, а оракул (`src/e2k/twoPassLayout.test.ts` §1.2) сверяет
 * объявленный размер с длиной, которую реально выдаёт кодировщик.
 *
 * # Разрядность disp
 *
 * `FIELD_BITS(C0F2, disp, 27, 0)` (`qemu/target/e2k/syllab-format.h:100`) — поле **28 бит**, и
 * читается оно **знаковым** (`FIELD_SEX32`). В ассемблере МЦСТ то же самое:
 * `u_int32_t disp:28;` (`binutils-gdb/gas/config/tc-e2k.c:1191`) и измеренные байты:
 * `disp %ctpr1, .L1` при цели **позади** команды на одно слово → `ff ff ff 4f`, то есть
 * `0x0fffffff` = −1. Диапазон: −2²⁷ … 2²⁷−1 (`docs/e2k-syllables-real.md` §4).
 *
 * # Чего здесь нет
 *
 * Раскладка **не** выравнивает команды и не вставляет заполнение: размеры кратны восьми, и
 * команда всегда начинается на границе восьми байт (`REAL_SHORT_FORM_SIZE = 8`). Широкой команды
 * нет: пара «подготовка + передача управления» — **две** команды по 8 байт
 * (`docs/e2k-real-run.md` §2.3, замер ассемблером).
 *
 * Инструкции, у которых формы понижения нет, **не размещаются** и попадают в
 * {@link LayoutTable.unplaced} с причиной. В напечатанном образе их и не будет, поэтому раскладка
 * описывает ровно тот образ, который собирается: адреса считаются по размещённым командам.
 * Следствие названо прямо: переход, чья цель не размещена, не получает смещения — это отказ с
 * причиной ({@link secondPass}), а не выдуманный адрес.
 */

import type { AsmInstruction, Operand, WideGroupShape } from "./backend";
import {
  STRING_ARENA_COPY_CARRIER,
  STRING_CALLS,
  stringArenaCopyInstructions,
  stringConcatInstructions,
  stringLengthInstructions,
  stringSymbolInstructions,
  stringWriteInstructions,
} from "./stringRuntime";
import { isStringPrint, stringMarksOf } from "./stringPlan";
import {
  BANK_LOAD_CARRIER,
  BANK_STORE_CARRIER,
  GETSP_CARRIER,
  WINDOW_GROW_CARRIER,
} from "./procedureCall";
import { arenaCarrierInstructions, isArenaCarrier } from "./arenaRuntime";
import { syscallFrameOfCarrier } from "./printCall";
import {
  CT_COND_ALWAYS, REAL_LONG_FORM_SIZE, REAL_SHORT_FORM_SIZE, isShortImmediate } from "./e2k-real";
import {
  PREDICATE_FOR_PAIRS,
  VALUE_BRANCH_COMPARISON,
  comparisonMnemonicOf,
  isMaterializingComparison,
  isValueBranchJump,
  pairPredicates,
} from "./predicatePairing";

import {
  ARRAY_REGISTERS,
  ARRAY_SLOT_CARRIER,
  ARRAY_VALUES_CARRIER,
  ARRAY_WINDOW_WSZ,
  CALLEE_ZERO_CARRIER,
  arraySlotPrologue,
  arrayValuePrologue,
  calleeZeroInstructions,
  lowerArrayCall } from "./arrayRuntime";
import {
  SUPPORTED_MATH_CALLS, lowerMathCall } from "./mathRuntime";
import { REMAINDER_CARRIER, remainderInstructions } from "./remainderRuntime";
import { callArgumentOperands } from "./shell";
import { MAX_CALL_ARGS } from "./emitterShell";
import { LOAD_CARRIER, STORE_CARRIER } from "./memoryAccess";
import { COLLECTION_ALLOC_CARRIER, COLLECTION_CALL_NAMES, collectionAllocInstructions, lowerCollectionCall } from "./collectionsRuntime";
import {
  EXIT_CARRIER,
  PRINT_HEAP_BY_CONVENTION,
  PRINT_SAVE_BYTES_PER_REGISTER,
  PRINT_SAVE_COUNT_OPERAND,
  PRINT_SAVE_SOURCE,
  PRINT_TEXT_CARRIER,
  PRINT_WRITE_CARRIER,
  exitCarrierInstructions,
  isPrintCallName,
  printCallInstructions,
  printCarrierForms,
  printCommandForm,
  printSaveCountOf,
  printTextInstructions,
  printWriteInstructions,
} from "./printCall";
import {
  LOWERING_CODES, failureOf, type LoweringFailure, type LoweringRefusalCode } from "./loweringRefusal";

const imm = (value: number): Operand => ({ kind: "imm", value });

// ─────────────────────────────────────────────────────────────────────────────
// РАЗРЯДНОСТЬ СМЕЩЕНИЯ
// ─────────────────────────────────────────────────────────────────────────────

/** Байт на единицу смещения: `disp` считается в восьмибайтовых словах. */
export const DISP_UNITS = 8;

/** Разрядность поля `disp` — `syllab-format.h:100` (`C0F2.disp[27:0]`). */
export const DISP_BITS = 28;

/** Минимальное смещение: поле знаковое (`FIELD_SEX32`), 28 бит. */
export const DISP_MIN = -(2 ** (DISP_BITS - 1));

/** Максимальное смещение. */
export const DISP_MAX = 2 ** (DISP_BITS - 1) - 1;

/** Откуда взята разрядность и знаковость — дословно, с файлами и строками. */
export const DISP_SOURCE =
  "qemu/target/e2k/syllab-format.h:100 (FIELD_BITS(C0F2, disp, 27, 0) — поле disp[27:0], 28 бит); " +
  "qemu/target/e2k/tcg/translate-ctp.c:74-75 (FIELD_SEX32(cs0, C0F2, disp) — знаковое чтение; " +
  "new_base = instr_state.ip + (disp << 3)); binutils-gdb/gas/config/tc-e2k.c:1191 (u_int32_t disp:28)";

// ─────────────────────────────────────────────────────────────────────────────
// ТАБЛИЦА ФОРМ
// ─────────────────────────────────────────────────────────────────────────────

/** Одна команда, которой понижается носитель IR, и её размер. */
export interface CommandForm {
  /** Мнемоника e2k — копия из таблицы (`src/e2k/e2k-real.ts`). */
  readonly mnemonic: string;
  /** Слог и форма; для управляющих команд — имя формы из `REAL_CONTROL_OPCODES`. */
  readonly form: string;
  /** Размер в байтах: 8 или 16. */
  readonly size: number;
  /** Источник размера. */
  readonly source: string;
}

/** Форма понижения носителя IR: одна команда или серия. */
export interface CarrierForm {
  /** Носитель IR (наше имя). */
  readonly carrier: string;
  /** Команды в порядке выдачи. */
  readonly commands: readonly CommandForm[];
}

const SHORT_SOURCE = `короткая форма, 8 байт — REAL_SHORT_FORM_SIZE (src/e2k/e2k-real.ts; qemu/target/e2k/instr-bits.h:41-45)`;
const LONG_SOURCE = `длинная форма ALS + ALES, 16 байт — REAL_LONG_FORM_SIZE (src/e2k/e2k-real.ts; qemu/target/e2k/syllab-format.h:85-91)`;
const LITERAL_SOURCE =
  `литерал (LTS) занимает слово команды: наш кодировщик кодирует литеральный операнд полем 0xd4/0xd8 ` +
  `в последнем слове (src/e2k/e2k-real.ts:encodeWithLiteral → REAL_LONG_FORM_SIZE); раскладка LTS — ` +
  `docs/e2k-syllables-real.md §4 (opcodes/e2k-dis.c:445-504)`;
const DISP_COMMAND_SOURCE =
  `CS0 формата C0F2, 8 байт — REAL_CONTROL_OPCODES[disp].size (src/e2k/e2k-real.ts); ` +
  `поле disp[27:0] — qemu/target/e2k/syllab-format.h:100`;
const CT_COMMAND_SOURCE =
  `SS формата SF1, 8 байт — REAL_CONTROL_OPCODES[ct].size (src/e2k/e2k-real.ts); ` +
  `измерено: ct %ctpr1 → 01 10 00 00 20 04 00 c0 (docs/e2k-syllables-real.md §4)`;
const CMP_COMMAND_SOURCE =
  `ALF7, 8 байт — REAL_SHORT_FORM_SIZE; запись сравнения и её источник — src/e2k/e2k-real.ts ` +
  `(opcodes/e2k-opc.h:999,1019,1024); обязательное поле nop = 2 — gas/config/tc-e2k.c:5923`;
/**
 * Материализация значения сравнения: перенос под предикатом-условием (`psrc`), 16 байт.
 *
 * Измерено ассемблером МЦСТ 2.41 (WSL, `/root/build-gas/gas/as-new`, 2026-10-29):
 * `movts,0 1, %b[1] ? %pred0` → `11 00 01 04 01 c1 c0 60 00 00 00 00 00 00 60 04`, то есть
 * HS + ALS (короткая непосредственная форма `0xc1 = 0xc0 | 1` — в слове ALS) + нулевое слово 2 +
 * слог-условие (`CDS`) в слове 3. Наш кодировщик даёт те же байты побайтово
 * (`.tmp/k5form-encode.ts`), и ту же длину объявляет здесь.
 */
const COMPARISON_VALUE_COMMAND_SOURCE =
  `ALF2 + слог-условие (CDS), 16 байт — REAL_LONG_FORM_SIZE; измерено ассемблером МЦСТ ` +
  `(movts,0 1, %b[1] ? %pred0 → 11 00 01 04 01 c1 c0 60 00 00 00 00 00 00 60 04) и сверено ` +
  `кодировщиком (.tmp/k5form-encode.ts); запись psrc — src/e2k/e2k-real.ts, CDS — ` +
  `docs/e2k-syllables-real.md §«слог-условие»`;
const SDIV_COMMAND_SOURCE =
  `ALF1, 8 байт — REAL_SHORT_FORM_SIZE; канал ТОЛЬКО пятый (opcodes/e2k-opc.h:69, ARGS_SSS); ` +
  `измерено кодировщиком (.tmp/idiv-form-size.ts): sdivs %b[1], %b[2], %b[3] → 01 00 00 80 03 02 01 42`;
const MOVTD_COMMAND_SOURCE =
  `ALF2 + литерал LTS, 16 байт — REAL_LONG_FORM_SIZE (src/e2k/e2k-real.ts); измерено кодировщиком ` +
  `(.tmp/spill-form-size.ts): movtd imm64, %b[5] → 11 00 00 04 05 dc c0 61 00 00 00 00 00 1f 10 00; каналы {0,1,3,4}`;
const MEMORY_COMMAND_SOURCE =
  `ALF1 (ldd) / ALF3 (std), 8 байт — REAL_SHORT_FORM_SIZE (src/e2k/e2k-real.ts); опкоды ldd 0x64…0x67 ` +
  `и std 0x24…0x27 (opcodes/e2k-opc.h:604-619,969-984); измерено ассемблером МЦСТ и кодировщиком ` +
  `(src/e2k/e2kMemory.test.ts); адрес — СУММА двух регистров, поля смещения в команде нет ` +
  `(qemu/target/e2k/tcg/translate-al-c11.c:26-34)`;

/**
 * Формы понижения — по одной на носитель.
 *
 * Размер каждой команды — **копия** из формы, а не догадка: у операций слога ALS он следует из
 * формы таблицы опкодов (ALF1/ALF2 — 8, ALF11 — 16), у литеральных — из раскладки LTS, у
 * управляющих — из поля `size` записи `REAL_CONTROL_OPCODES`. Оракул §1.2 сверяет это с длиной,
 * которую выдаёт кодировщик, поэтому расхождение объявления и реализации не пройдёт молча.
 */
export const CARRIER_FORMS: readonly CarrierForm[] = [
  {
    carrier: "IR.const",
    commands: [{ mnemonic: "movts", form: "ALF2 + LTS", size: REAL_LONG_FORM_SIZE, source: LITERAL_SOURCE }],
  },
  {
    carrier: "IR.move",
    commands: [{ mnemonic: "movts", form: "ALF2", size: REAL_SHORT_FORM_SIZE, source: SHORT_SOURCE }],
  },
  {
    /**
     * `IR.zero [регистр]` — положить НОЛЬ в регистр (одна короткая пересылка).
     *
     * Нужен разделённой печати: её сохранение/восстановление адресуют слот парой «основание + смещение»,
     * и смещение обязано быть нулём в РЕГИСТРЕ. Ноль рантайма (`%b[12]`) для этого не годится: после
     * возврата из вызываемой окно вызывающего сужено до `%b[0..11]` — измерено, `%b[12]` недоступен,
     * а `%b[11]` ещё доступен (`.tmp/osnova-after-call-window.ts`). Поэтому ноль кладётся в НИЗКИЙ
     * регистр, которого не касаются ни вызываемая (её окно — `%b[8..15]`), ни хвост `write`
     * (`%b[2]`, `%b[4]`, `%b[6]`, `%b[9]` и оконные `%r8..%r11`).
     */
    carrier: "IR.zero",
    commands: [{ mnemonic: "movts", form: "ALF2", size: REAL_SHORT_FORM_SIZE, source: SHORT_SOURCE }],
  },
  {
    carrier: "IR.add",
    commands: [{ mnemonic: "adds", form: "ALF1", size: REAL_SHORT_FORM_SIZE, source: SHORT_SOURCE }],
  },
  {
    carrier: "IR.sub",
    commands: [{ mnemonic: "subs", form: "ALF1", size: REAL_SHORT_FORM_SIZE, source: SHORT_SOURCE }],
  },
  {
    /**
     * `IR.load [адрес, приёмник]` — чтение по адресу-РЕГИСТРУ (`src/e2k/memoryAccess.ts`).
     *
     * Отличие от `IR.spill_ld` — в том, ЧТО адресуется: у вытеснения это ЛИТЕРАЛЬНЫЙ слот (понижение
     * кладёт его в регистр `movtd`), здесь — регистр, пришедший готовым. Формы у обеих команд одни и
     * те же (ALF3/ALF1), и длина та же — но форма берётся из ТОГО ЖЕ источника, что понижение, а не
     * «похожая»: разойдись они, уехали бы адреса переходов (класс §3.35).
     */
    carrier: LOAD_CARRIER,
    commands: [{ mnemonic: "ldd", form: "ALF1", size: REAL_SHORT_FORM_SIZE, source: SHORT_SOURCE }],
  },
  {
    /** `IR.store [значение, адрес]` — запись по адресу-РЕГИСТРУ; канал 2, как у всех `st*`. */
    carrier: STORE_CARRIER,
    commands: [{ mnemonic: "std", form: "ALF3", size: REAL_SHORT_FORM_SIZE, source: SHORT_SOURCE }],
  },
  {
    // Целочисленное деление (БЛОК 2, оператор `div`). Форма объявлена 2026-09-25: правило понижения
    // (`src/e2k/e2kRealRun.ts`, `sdivs`) в таблице понижения БЫЛО, а формы размера здесь не было — и
    // раскладка объявляла «формы понижения нет» на единственном оставшемся носителе конвейера
    // (измерено: `.tmp/measure-realrun-div.out.txt`, отказ переехал с `IR.div` на `IR.idiv`).
    carrier: "IR.idiv",
    commands: [{ mnemonic: "sdivs", form: "ALF1", size: REAL_SHORT_FORM_SIZE, source: SDIV_COMMAND_SOURCE }],
  },
  {
    carrier: "IR.mul",
    commands: [{ mnemonic: "muls", form: "ALF11", size: REAL_LONG_FORM_SIZE, source: LONG_SOURCE }],
  },
  {
    // Пара «подготовка + передача управления» — ДВЕ команды по 8 байт, а не одна широкая:
    // замер ассемблером МЦСТ (docs/e2k-real-run.md §2.3, src/e2k/e2kSyllables.test.ts).
    carrier: "IR.jmp",
    commands: [
      { mnemonic: "disp", form: "CS0_DISP (C0F2)", size: REAL_SHORT_FORM_SIZE, source: DISP_COMMAND_SOURCE },
      { mnemonic: "ct", form: "SS (SF1)", size: REAL_SHORT_FORM_SIZE, source: CT_COMMAND_SOURCE },
    ],
  },
  {
    // Условный переход — та же пара, только `ct` несёт ещё и код условия (`SS.ctcond`):
    // `? %predN` (0x40) или `? ~%predN` (0x60). Размер от условия не зависит — обе команды по 8.
    carrier: "IR.jmp_if",
    commands: [
      { mnemonic: "disp", form: "CS0_DISP (C0F2)", size: REAL_SHORT_FORM_SIZE, source: DISP_COMMAND_SOURCE },
      { mnemonic: "ct", form: "SS (SF1) с условием", size: REAL_SHORT_FORM_SIZE, source: CT_COMMAND_SOURCE },
    ],
  },
  {
    carrier: "IR.jmp_if_not",
    commands: [
      { mnemonic: "disp", form: "CS0_DISP (C0F2)", size: REAL_SHORT_FORM_SIZE, source: DISP_COMMAND_SOURCE },
      { mnemonic: "ct", form: "SS (SF1) с условием", size: REAL_SHORT_FORM_SIZE, source: CT_COMMAND_SOURCE },
    ],
  },
  // Сравнения: одна команда формы ALF7, 8 байт (`pdst[4:0]` — предикат-приёмник). Код условия
  // выбирает сопоставление (`src/e2k/predicatePairing.ts`): у `ge`/`gt`/`ne` он тот же, что у
  // `lt`/`le`/`eq`, но предикат читается с отрицанием — условий «больше» в наборе таблицы нет.
  {
    // Вытеснение в память (`src/vliw/spill.ts`): сперва адрес слота литералом, затем обращение.
    // Две команды, а не одна, и это измерено: в e2k адрес памяти — **сумма двух регистров**, поля
    // смещения в команде нет, поэтому адрес (он же номер слота) обязан сперва попасть в регистр.
    carrier: "IR.spill_ld",
    commands: [
      { mnemonic: "movtd", form: "ALF2 + LTS", size: REAL_LONG_FORM_SIZE, source: MOVTD_COMMAND_SOURCE },
      { mnemonic: "ldd", form: "ALF1", size: REAL_SHORT_FORM_SIZE, source: MEMORY_COMMAND_SOURCE },
    ],
  },
  {
    carrier: "IR.spill_st",
    commands: [
      { mnemonic: "movtd", form: "ALF2 + LTS", size: REAL_LONG_FORM_SIZE, source: MOVTD_COMMAND_SOURCE },
      { mnemonic: "std", form: "ALF3", size: REAL_SHORT_FORM_SIZE, source: MEMORY_COMMAND_SOURCE },
    ],
  },
  {
    carrier: "IR.lt",
    commands: [{ mnemonic: "cmplsb", form: "ALF7", size: REAL_SHORT_FORM_SIZE, source: CMP_COMMAND_SOURCE }],
  },
  {
    carrier: "IR.le",
    commands: [{ mnemonic: "cmplesb", form: "ALF7", size: REAL_SHORT_FORM_SIZE, source: CMP_COMMAND_SOURCE }],
  },
  {
    carrier: "IR.eq",
    commands: [{ mnemonic: "cmpesb", form: "ALF7", size: REAL_SHORT_FORM_SIZE, source: CMP_COMMAND_SOURCE }],
  },
  {
    carrier: "IR.ge",
    commands: [{ mnemonic: "cmplsb", form: "ALF7", size: REAL_SHORT_FORM_SIZE, source: CMP_COMMAND_SOURCE }],
  },
  {
    carrier: "IR.gt",
    commands: [{ mnemonic: "cmplesb", form: "ALF7", size: REAL_SHORT_FORM_SIZE, source: CMP_COMMAND_SOURCE }],
  },
  {
    carrier: "IR.ne",
    commands: [{ mnemonic: "cmpesb", form: "ALF7", size: REAL_SHORT_FORM_SIZE, source: CMP_COMMAND_SOURCE }],
  },
];

const FORMS_BY_CARRIER: ReadonlyMap<string, CarrierForm> = new Map(
  CARRIER_FORMS.map((form) => [form.carrier, form]),
);

/** Форма понижения носителя; `undefined` — формы нет, инструкция не размещается. */
export function carrierForm(carrier: string): CarrierForm | undefined {
  return FORMS_BY_CARRIER.get(carrier);
}

/**
 * Формы команд рантайма массивов: `addd`, `ldd`, `std` — все ALF1, по 8 байт.
 *
 * Рантайм выражает вызовы массивов **только** этими командами и только регистрами (литералов в них
 * нет: `src/e2k/arrayRuntime.ts`, `timesEight` — три `addd`). Размеры всё равно берутся из формы, а не
 * из арифметики «сколько байт мне кажется»: оракул сверяет их с кодировщиком.
 *
 * `addd` (формат `D`, `opcodes/e2k-opc.h:24`) стоит здесь вместо `adds` с 2026-09-27: адрес —
 * величина 64-битная, а `S`-формы пишут только младшую половину регистра (§3.27 `docs/hardware-debt.md`).
 * Длина та же — 8 байт (ALF1), поэтому раскладка и закреплённые числа не двигаются; проверено
 * прогоном (`.tmp/osnova-addd-probe.ts`) и сверкой байт дизассемблером МЦСТ.
 */
const ADDD_COMMAND_SOURCE =
  'opcodes/e2k-opc.h:24 (ARGS_DDD, формат D — %db) — ALF1, REAL_SHORT_FORM_SIZE; байты сверены ' +
  'дизассемблером МЦСТ (docs/hardware-debt.md §3.27: …11)';

export const ARRAY_COMMAND_FORMS: ReadonlyMap<string, CommandForm> = new Map([
  ['addd', { mnemonic: 'addd', form: 'ALF1', size: REAL_SHORT_FORM_SIZE, source: ADDD_COMMAND_SOURCE }],
  // Математика (рантайм остатка): `smodx` — ALF1, канал только пятый, 8 байт. Форма из таблицы МЦСТ
  // (`src/e2k/e2k-real.ts`, `opcodes/e2k-opc.h:54`), длина — короткая форма REAL_SHORT_FORM_SIZE.
  ['smodx', { mnemonic: 'smodx', form: 'ALF1', size: REAL_SHORT_FORM_SIZE, source: 'opcodes/e2k-opc.h:54 (ARGS_DSS, канал 5)' }],
  [
    'ldd',
    {
      mnemonic: 'ldd',
      form: 'ALF3',
      size: REAL_SHORT_FORM_SIZE,
      source:
        'ALF3 (src1[23:16], src2[15:8], src3[7:0]) — REAL_SHORT_FORM_SIZE; адрес = сумма двух ' +
        'регистров (qemu/target/e2k/tcg/translate-al-c11.c:26-34), измерено docs/e2k-opcodes-real.md §5',
    },
  ],
  [
    'std',
    {
      mnemonic: 'std',
      form: 'ALF3',
      size: REAL_SHORT_FORM_SIZE,
      source:
        `ALF3, REAL_SHORT_FORM_SIZE; каналы только 2 и 5 (opcodes/e2k-opc.h:969-984), порядок операндов ` +
        `текста — (значение, база, смещение): измерено .tmp/std-order.ts`,
    },
  ],
]);

/** Что нужно, чтобы взять форму носителя: для `IR.invoke` — имена хост-вызовов образа. */
export interface CarrierFormContext {
  /**
   * Таблица имён хост-вызовов (`ShellImage.invokeNames`): `payload` носителя `IR.invoke` — это
   * **индекс** в ней, и без неё длину понижения взять негде.
   */
  readonly invokeNames?: readonly string[];
  /**
   * Пул констант модуля (`ShellEmitResult.scheduled.constants`). Нужен носителю `IR.const`: его
   * операнд — **индекс** в пуле, а длина понижения зависит от ЗНАЧЕНИЯ литерала (0…15 кодируются
   * короткой непосредственной формой, 8 байт; остальные — литеральной, 16 байт).
   */
  readonly constants?: readonly unknown[];
  /**
   * Адрес кучи образа. Нужен единственному носителю — печатающему `IR.invoke`: раскладка выводит из
   * него команды развёртки, чтобы сложить их длины. На ЗНАЧЕНИЯ адрес не влияет (площадка кладётся
   * `movtd` — всегда 16 байт), поэтому без него берётся конвенция образа.
   */
  readonly heapAddress?: number;
  /**
   * ИСПОЛНЯЕТСЯ ли носитель `IR.ret` как возврат процедуры.
   *
   * Возврат в этом порте — ПАРА команд (`return %ctpr3` + `ct %ctpr3`): одна `return` валит
   * утверждение, одна `ct` — ловушка (`src/e2k/e2kCallWindowQemu.test.ts`, шлюз). Значит у формы
   * `IR.ret` два честных размера: 24/16 байт там, где возврат ИСПОЛНЯЕТСЯ (вызываемая процедура),
   * и прежние 16/8 там, где носитель только КОДИРУЕТСЯ, а исполняется не он (точка входа:
   * её выход — `exit`; замеры ядер — тот же случай). Раскладка обязана считать ровно те байты,
   * что выдаёт понижение, иначе адреса уезжают (`docs/hardware-debt.md` §3.35).
   */
  readonly procedureReturn?: boolean;
  /**
   * Индексы носителей, которые в образ НЕ ПОПАДАЮТ и потому получают размер 0.
   *
   * Так называется один случай: возвраты точки входа. Их не исполняет никто (выход точки входа —
   * `exit`), но раскладка обязана знать об этом ЗАРАНЕЕ, иначе адреса процедур за ними уезжают
   * (`src/e2k/procedureCall.ts#prepareImage`).
   */
  readonly zeroSize?: readonly number[];
}

/**
 * Команды, которыми понижается вызов и возврат: размеры — из той же таблицы форм.
 *
 * `movts` — короткая форма ALF2 (8 байт), `disp` — CS0 формата C0F2 (8), `call` — CS1 формата C1F1
 * вместе со слогами SS (**16**), `return` — CS0 (8). Байты `call %ctpr1, wbs=4` и `return %ctpr3`
 * измерены ассемблером МЦСТ (`docs/e2k-minimal-elf.md` §3, `src/e2k/e2k-real.ts` `REAL_CONTROL_OPCODES`).
 */
const CALL_COMMAND_FORMS: ReadonlyMap<string, CommandForm> = new Map([
  ['movts', { mnemonic: 'movts', form: 'ALF2', size: REAL_SHORT_FORM_SIZE, source: SHORT_SOURCE }],
  ['disp', { mnemonic: 'disp', form: 'CS0_DISP (C0F2)', size: REAL_SHORT_FORM_SIZE, source: DISP_COMMAND_SOURCE }],
  [
    'call',
    {
      mnemonic: 'call',
      form: 'CS1_CALL (SS + C1F1)',
      size: REAL_LONG_FORM_SIZE,
      source:
        'CS1 формат C1F1 (opc=5, `param`=wbs) вместе со слогом SS; измерено ассемблером: ' +
        '`call %ctpr1, wbs=4` → 16 байт (docs/e2k-minimal-elf.md §3)',
    },
  ],
  [
    'return',
    {
      mnemonic: 'return',
      form: 'CS0_RETURN',
      size: REAL_SHORT_FORM_SIZE,
      source: 'CS0, `ctp_opc = 0`; измерено ассемблером: `return %ctpr3` → 8 байт (docs/e2k-minimal-elf.md §3)',
    },
  ],
  [
    // ВТОРАЯ ПОЛОВИНА ВОЗВРАТА. Одна `return %ctpr3` в порте валит утверждение (`op_descr->is_al`,
    // статус 134), одна `ct %ctpr3` — ловушка (статус 9): `call` стирает ctpr в пустой тег.
    // Управление возвращает только ПАРА (`src/e2k/e2kCallWindowQemu.test.ts`, шлюз; `docs/e2k-return-port.md`).
    // Форма обязана считать те же байты, что выдаёт понижение (`src/e2k/e2kRealRun.ts`, ветвь `IR.ret`):
    // расхождение формы и понижения уже стоило нам уехавших адресов (docs/hardware-debt.md §3.35).
    'ct',
    {
      mnemonic: 'ct',
      form: 'SS (SF1)',
      size: REAL_SHORT_FORM_SIZE,
      source:
        'SS формата SF1, 8 байт — REAL_CONTROL_OPCODES[ct].size (src/e2k/e2k-real.ts); измерено: ' +
        '`ct %ctpr1` → 01 10 00 00 20 04 00 c0 (docs/e2k-syllables-real.md §4)',
    },
  ],
]);

/**
 * Окно вызова в шестнадцатибайтных единицах: `wbs = 4`.
 *
 * Меньше нельзя — модель требует `wbs ≥ psize_q`, а начальный `psize_q = 4`
 * (`qemu/linux-user/e2k/cpu_loop.c:302-303`, `translate-ct.c` `helper_e2k_prep_ct_CALL`). Именно
 * поэтому аргументы вызываемого кладутся в `%r(2*wbs) = %r8` регистры вызывающего: индекс окна
 * считается как `(base_d + idx)`, а `call` прибавляет `2*wbs` двоичных слов (`reg-index.h:79`).
 */
export const CALL_WBS = 4;

/**
 * БЮДЖЕТ РЕГИСТРОВ ВЫЗЫВАЕМОЙ: только её СОБСТВЕННАЯ половина кадра — `%b[8 .. 23]`, МИНУС клетка
 * нуля `%b[12]`, закреплённая за нулём ПО ПОСТРОЕНИЮ. Пятнадцать общих клеток.
 *
 * # Почему это закон окна, а не стиль
 *
 * `call wbs = 4` сдвигает окно вызываемой на `2*wbs = 8` регистров (`reg-index.h:79`), поэтому
 * `%b[n]` **вызываемой** — это `%b[n + 8]` **вызывающего**:
 *
 * | регистр вызываемой | чей он на самом деле |
 * |---|---|
 * | `%b[0]`, `%b[1]` | аргументы вызова (соглашение ABI) |
 * | `%b[2..7]` | `%b[10..15]` вызывающего — **рантайм массивов** (`ARRAY_REGISTERS`) |
 * | `%b[8..11]`, `%b[13..23]` | собственные регистры вызываемой: вызывающий их адресовать не может |
 * | `%b[12]` | **закреплена за нулём** этой плоскости (см. ниже) — раскладке не выдаётся |
 *
 * Раскладка, выдавшая вызываемой `%b[2..7]`, затирает ЧУЖОЕ состояние молча. Замер
 * (`.tmp/osnova-reread-which.ts`, `docs/hardware-debt.md` §3.96): одна и та же арифметика
 * `(а + 1) + б` = 11 на модели, временные регистры вызываемой —
 * `%b[2..4]` → **15**, `%b[4..8]` → **14**, `%b[8..12]` → **11**, `%b[12..15]` → **11**.
 * Разница В ТОЧНОСТИ равна тому, что вызываемая оставила в своём `%b[4]`: выход программы считает
 * `код = значение + %b[12]` (`src/e2k/printCall.ts#exitCarrierInstructions`), а `%b[4]` вызываемой —
 * это `%b[12]` вызывающего. Отсюда «тихая ложь»: программа «собралась», отказов понижения 0,
 * а значение чужое.
 *
 * # ПОЧЕМУ ВОСЬМИ КЛЕТОК БОЛЬШЕ НЕТ, А ПЯТНАДЦАТЬ ЕСТЬ (замер 2026-11-04, §3.166)
 *
 * Прежняя редакция перечисляла ровно восемь клеток `%b[8..15]` и объясняла это законом окна. Закон
 * записан верно, но ПРЕДЕЛ был взят не тот: спецификация (`OpenE2K/relcc2` `spec/abi/registers.md`)
 * даёт предел клеток вызываемой `min(2·(rsz + 1), 2·(wsz − wbs))`, а у листовой вызываемой первое
 * слагаемое равно `2` — порт зануляет `%br` на каждом `call`, своего `setbn` у неё нет. Значит клетки
 * даёт `wsz`, а не `rsz`, и их `2·(wsz − 4)`. Замер лестницей (`.tmp/a502-window-law.ts`, оракул
 * `src/e2k/windowLimits.test.ts`): `wsz` 12/13/14/16 → предел 16/18/20/24, и первая недоступная
 * клетка равна ровно `2·(wsz − 4)` во всех четырёх строках.
 *
 * При `ARRAY_WINDOW_WSZ = 12` это давало 16 единиц, то есть ровно `%b[8..15]` — восемь клеток, и
 * список был верен. Пролог образа теперь ставит `setwd wsz = 16` (§3.166, шаг 2 атома ATOM-05-02-01),
 * поэтому своих клеток у вызываемой `%b[8..23]` — ШЕСТНАДЦАТЬ.
 *
 * # ЗАЧЕМ КЛЕТКА НУЛЯ И ПОЧЕМУ ОНА ВЫВЕДЕНА ИЗ ПУЛА
 *
 * Переход, ветвящийся ПО ЗНАЧЕНИЮ (`если A и B`, `src/e2k/predicatePairing.ts#VALUE_BRANCH_JUMP`),
 * делает предикат командой `cmpesb значение, НОЛЬ`, и ноль этот обязан быть равен нулю **по
 * построению** — иначе предикат считается от мусора и переход ветвится не туда молча (это и есть
 * седьмая тихая ложь, сторож `src/e2k/calleeJoinLie.test.ts`).
 *
 * В плоскости ТОЧКИ ВХОДА такая клетка есть и держится двумя местами: пролог образа пишет в `%b[12]`
 * ноль (`arrayPrologue`), а `RESERVED_REGISTERS` эту клетку раскладке не выдаёт. В плоскости
 * ВЫЗЫВАЕМОЙ ни одного из двух не было, поэтому понижение отказывало по имени — честно, но
 * бесполезно: `если а >= 48 и а <= 57` в процедуре не собиралось вовсе.
 *
 * Теперь ноль вызываемой ставит ЕЁ ПРОЛОГ (носитель `IR.callee_zero` →
 * `src/e2k/arrayRuntime.ts#calleeZeroInstructions`), а клетка выведена из пула ЗДЕСЬ — тем же
 * вычитанием, каким `RESERVED_REGISTERS` держит её в плоскости входа. Номер берётся у
 * {@link ARRAY_REGISTERS}.zero, а не пишется числом: понижение сравнивает значение ровно с этой
 * клеткой (`e2kRealRun.ts`, `reg(ARRAY_REGISTERS.zero)`), и разойтись этим двум записям нечем.
 *
 * ПОЧЕМУ ВЫЧЕРКИВАНИЕМ ИЗ СПИСКА, А НЕ ЧЕРЕЗ `reserved`: `reserved` — общий для ОБЕИХ плоскостей
 * (`allocateProgram` фильтрует им бюджет каждой процедуры), поэтому клетка, добавленная туда,
 * отнялась бы и у точки входа. А в плоскости входа `%b[12]` уже держится своим механизмом
 * (`RESERVED_REGISTERS`), и трогать его нельзя: там же стоят единица и восемь, которые читают печать,
 * строки и коллекции.
 *
 * Константа живёт ЗДЕСЬ, рядом с `CALL_WBS`, а не в модуле соглашения о вызове: вычисленная на
 * загрузке модуля из чужой константы, она при ином порядке импортов становится `NaN` — и раскладка
 * молча уходит в вытеснение вместо отказа (это и случилось: `npx tsx` давал 11, а прогон vitest —
 * отказ раскладки на той же программе).
 */
export const CALLEE_ZERO_CELL = ARRAY_REGISTERS.zero;

/** Первая СОБСТВЕННАЯ клетка вызываемой: за аргументами и чужой половиной кадра. */
export const CALLEE_OWN_FIRST = 2 * CALL_WBS;

/** Последняя собственная клетка вызываемой по измеренному закону окна: `2·(wsz − wbs) − 1`. */
export const CALLEE_OWN_LAST = 2 * (ARRAY_WINDOW_WSZ - CALL_WBS) - 1;

export const CALLEE_REGISTERS: readonly number[] = Array.from(
  { length: CALLEE_OWN_LAST - CALLEE_OWN_FIRST + 1 },
  (_, at) => CALLEE_OWN_FIRST + at,
).filter((cell) => cell !== CALLEE_ZERO_CELL);

/** Где в операндах носителя лежат признаки вызова: `flags = (есть приёмник) | (аргументов << 1)`. */
function callFlags(instruction: AsmInstruction): { argc: number; hasDestination: boolean } | undefined {
  const flags = instruction.operands[0];
  if (flags === undefined || flags.kind !== 'imm') return undefined;
  return { argc: flags.value >> 1, hasDestination: (flags.value & 1) === 1 };
}

/**
 * Итог взятия формы: либо форма, либо ОТКАЗ С КОДОМ (`OSN-LOW-*`).
 *
 * Код здесь обязателен по той же причине, что и в понижении: наблюдатель обязан отличать
 * «язык этого не умеет» от «конвейер получил носитель не той формы», а по тексту причины
 * это неразличимо (`src/e2k/loweringRefusal.ts`).
 */
interface CarrierFormOutcome {
  readonly form?: CarrierForm;
  readonly failure?: LoweringFailure;
}

/** Форма вызова: пересылки аргументов в окно вызываемого + `disp` + `call` + чтение результата. */
function callForm(instruction: AsmInstruction): CarrierFormOutcome {
  const flags = callFlags(instruction);
  if (flags === undefined) {
    return { failure: failureOf(LOWERING_CODES.carrier, '«IR.call»: операнд флагов не число — арность вызова неизвестна') };
  }
  if (flags.argc > MAX_CALL_ARGS) {
    return {
      failure: failureOf(
        LOWERING_CODES.runtime,
        `«IR.call»: аргументов ${String(flags.argc)}, носитель несёт не больше ${String(MAX_CALL_ARGS)}`,
      ),
    };
  }
  const commands: CommandForm[] = [];
  for (let argument = 0; argument < flags.argc; argument++) commands.push(CALL_COMMAND_FORMS.get('movts')!);
  commands.push(CALL_COMMAND_FORMS.get('disp')!);
  commands.push(CALL_COMMAND_FORMS.get('call')!);
  // Результат вызываемого приходит в его `%r0` — это регистр `%r(2*wbs)` вызывающего; читать его
  // надо после возврата, поэтому пересылка идёт последней.
  if (flags.hasDestination) commands.push(CALL_COMMAND_FORMS.get('movts')!);
  return { form: { carrier: 'IR.call', commands } };
}

/** Форма возврата: пересылка значения в приёмник соглашения (`%r0` вызываемого) + `return %ctpr3`. */
function retForm(instruction: AsmInstruction, procedureReturn: boolean): CarrierFormOutcome {
  const flag = instruction.operands[0];
  if (flag === undefined || flag.kind !== 'imm') {
    return { failure: failureOf(LOWERING_CODES.carrier, '«IR.ret»: операнд «есть значение» не число') };
  }
  // Результат (если он есть) уезжает в свой `%r0` пересылкой. Возврат ИСПОЛНЯЕТСЯ парой
  // (`return` + `ct`) там, где из процедуры действительно возвращаются; в точке входа носитель
  // не исполняется вовсе (её выход — `exit`), и там форма остаётся прежней, однокомандной.
  const commands: CommandForm[] = flag.value === 1 ? [CALL_COMMAND_FORMS.get('movts')!] : [];
  commands.push(CALL_COMMAND_FORMS.get('return')!);
  if (procedureReturn) commands.push(CALL_COMMAND_FORMS.get('ct')!);
  return { form: { carrier: 'IR.ret', commands } };
}

/** Форма носителя или причина, почему её нет. Причина называется, а не подменяется догадкой. */
/**
 * Форма носителя `IR.const`: длина зависит от ЗНАЧЕНИЯ литерала.
 *
 * Кодировщик кладёт значение 0…15 короткой непосредственной формой — 8 байт (`src/e2k/e2k-real.ts`,
 * `isShortImmediate`, `encodeShortImm`), а большее — литеральной, 16 байт (LTS). Модель форм обязана
 * знать то же правило: иначе `secondPass` считает смещения переходов по одним длинам, а образ
 * собирается из других. Измерено: без этого правила обратный переход цикла уводил за начало
 * программы (3 расхождения длин из 13, `.tmp/form-size-probe.ts`).
 *
 * Если пул констант не передан, берётся литеральная форма (как было до короткой), и это **названо**
 * в поле `source`: молчаливой подмены длины нет.
 */
function constForm(instruction: AsmInstruction, context: CarrierFormContext): CarrierForm {
  const poolIndex = instruction.operands[1];
  const pool = context.constants;
  const value = poolIndex !== undefined && poolIndex.kind === 'imm' ? pool?.[poolIndex.value] : undefined;
  const short = typeof value === 'number' && isShortImmediate(value, "ALF2");
  return {
    carrier: "IR.const",
    commands: [
      {
        mnemonic: "movts",
        form: short ? "ALF2 + короткая непосредственная (0xc0|N)" : "ALF2 + LTS",
        size: short ? REAL_SHORT_FORM_SIZE : REAL_LONG_FORM_SIZE,
        source: short
          ? `значение ${String(value)} ∈ 0…15 — короткая непосредственная форма, 8 байт (` +
            'измерено: movts,0 5, %b[1] → 01 00 00 04 01 c5 c0 60; src/e2k/e2k-real.ts encodeShortImm)'
          : pool === undefined
            ? 'пул констант не передан — взята литеральная форма (LTS, 16 байт), длина НЕ проверена по значению'
            : 'значение вне 0…15 — литеральная форма (LTS, 16 байт)',
      },
    ],
  };
}

/** Форма сохранения живых регистров вокруг сайта печати: `movtd`+`std` … `movtd`+`ldd`. */
function saveForm(saveCount: number): CommandForm {
  return {
    mnemonic: 'movtd+std / movtd+ldd',
    form: 'вытеснение вокруг печати',
    size: saveCount * PRINT_SAVE_BYTES_PER_REGISTER,
    source: PRINT_SAVE_SOURCE,
  };
}

function carrierFormWithReason(
  instruction: AsmInstruction,
  context: CarrierFormContext,
): CarrierFormOutcome {
  // КАДР СИСТЕМНОГО ВЫЗОВА носителя печати: у процедуры с выращенным окном номер идёт в `%r16`,
  // а не в `%r8` (§3.58). Длины команд от кадра НЕ зависят (те же команды, другие индексы) —
  // поэтому формы одинаковы, но берутся ИЗ ТОГО ЖЕ источника, что и понижение: разойтись нечем.
  const frame = syscallFrameOfCarrier(instruction);
  // АРЕНА: длины берутся ИЗ ТЕХ ЖЕ КОМАНД, что понижает конвейер (`arenaCarrierInstructions`), —
  // форма обязана совпасть с байтами, иначе уедут адреса переходов и вызовов (§3.35). Прежняя
  // редакция объявляла заведение (`movtd` с 64-битным литералом) двумя командами по 8 байт: это на
  // 16 байт меньше правды, и сторож форм (`src/e2k/procedureCall.test.ts`) это ловит.
  if (isArenaCarrier(instruction)) {
    const commands = arenaCarrierInstructions(instruction);
    const forms = commands?.map((command) => printCommandForm(command));
    if (forms === undefined || forms.some((form) => form === undefined)) {
      return {
        failure: failureOf(
          LOWERING_CODES.carrier,
          `«${instruction.mnemonic}»: форму команды арены взять негде — ` +
            "понижение арены обязано давать команды известных форм (src/e2k/arenaRuntime.ts)",
        ),
      };
    }
    return {
      form: {
        carrier: instruction.mnemonic,
        commands: forms.map((form) => form!),
      },
    };
  }
  // РАСШИРЕНИЕ КУЧИ ПОД КОЛЛЕКЦИЮ (`src/e2k/collectionsRuntime.ts#COLLECTION_ALLOC_CARRIER`): длины
  // берутся ИЗ ТЕХ ЖЕ КОМАНД, что понижает конвейер (`collectionAllocInstructions`), — форма обязана
  // совпасть с байтами, иначе уедут адреса переходов и вызовов (§3.35). Команды здесь ДВУХ семейств
  // (`addd` — адресная арифметика рантайма массивов, `movts`/`sdisp`/`call` — системный вызов), и это
  // то же разделение, что у понижения вызова: пересечение таблиц одно (`ldd`/`std`) и размеры в нём
  // совпадают, а расхождение поймал бы оракул сверки форм.
  if (instruction.mnemonic === COLLECTION_ALLOC_CARRIER) {
    const capacity = instruction.operands[0];
    const destination = instruction.operands[1];
    const shaped = capacity?.kind === 'reg' && destination?.kind === 'reg';
    const commands = shaped
      ? collectionAllocInstructions(capacity.index, destination.index, syscallFrameOfCarrier(instruction))
      : undefined;
    const forms = commands?.map((command) => ARRAY_COMMAND_FORMS.get(command.mnemonic) ?? printCommandForm(command));
    if (forms === undefined || forms.some((form) => form === undefined)) {
      return {
        failure: failureOf(
          LOWERING_CODES.carrier,
          `«${instruction.mnemonic}»: форму команды расширения кучи взять негде — операнды носителя ` +
            'или команды понижения разошлись (src/e2k/collectionsRuntime.ts)',
        ),
      };
    }
    return { form: { carrier: instruction.mnemonic, commands: forms.map((form) => form!) } };
  }
  // СКЛЕЙКА СВЕРХ СТАТИЧЕСКОГО БУФЕРА (БЛОК АРЕНЫ): длины берутся ИЗ ТЕХ ЖЕ КОМАНД, что понижает
  // конвейер (`src/e2k/stringRuntime.ts#stringArenaCopyInstructions`) — форма обязана совпасть с
  // байтами, иначе уедут адреса переходов и вызовов (§3.35). Выделение и проверка предела к этому
  // носителю не относятся: их выпускает сайт арены, и формы у них те же, что у `память.выделить`.
  if (instruction.mnemonic === STRING_ARENA_COPY_CARRIER) {
    const first = instruction.operands[0];
    const second = instruction.operands[1];
    const block = instruction.operands[2];
    const firstBytes = instruction.operands[3];
    const secondBytes = instruction.operands[4];
    const shaped =
      first?.kind === 'reg' &&
      second?.kind === 'reg' &&
      block?.kind === 'reg' &&
      firstBytes?.kind === 'imm' &&
      secondBytes?.kind === 'imm';
    const commands = shaped
      ? stringArenaCopyInstructions({
          first: first.index,
          second: second.index,
          base: block.index,
          firstBytes: firstBytes.value,
          secondBytes: secondBytes.value,
        })
      : undefined;
    const forms = commands?.map((command) => printCommandForm(command));
    if (forms === undefined || forms.some((form) => form === undefined)) {
      return {
        failure: failureOf(
          LOWERING_CODES.carrier,
          `«${instruction.mnemonic}»: форму команды копирования в блок арены взять негде — ` +
            'операнды носителя или команды понижения разошлись (src/e2k/stringRuntime.ts)',
        ),
      };
    }
    return { form: { carrier: instruction.mnemonic, commands: forms.map((form) => form!) } };
  }
  // РОСТ ОКНА у процедуры, которая сама вызывает: `setwd wsz=16` (CS1_SETWD, 16 байт — измерено
  // кодировщиком, `.tmp/osnova-setwd-encode.ts`) плюс `setbn rsz=15` (ALF2, 8 байт). Объявление
  // обязано совпасть с понижением — сторож в `src/e2k/procedureCall.test.ts` кодирует те же команды.
  // БАНК: длины объявляются ТЕМ ЖЕ источником, что и понижение (§3.35 — форма обязана совпасть с
  // байтами, иначе уезжают адреса). `IR.getsp` = 16 (getsp) + 8 (чтение приёмника оконной формой);
  // запись и чтение банка — один `movts` по 8.
  if (
    instruction.mnemonic === GETSP_CARRIER ||
    instruction.mnemonic === BANK_STORE_CARRIER ||
    instruction.mnemonic === BANK_LOAD_CARRIER
  ) {
    const commands =
      instruction.mnemonic === GETSP_CARRIER
        ? [
            {
              mnemonic: 'getsp',
              form: 'ALOPF12_GETSP' as const,
              size: 16,
              source: 'измерено: `getsp,0 -16, %db[10]` → 16 байт (docs/hardware-debt.md §3.46.1)',
            },
            {
              mnemonic: 'movts',
              form: 'ALF2' as const,
              size: REAL_SHORT_FORM_SIZE,
              source: 'ALF2, 8 байт — чтение приёмника оконной формой',
            },
          ]
        : [
            {
              mnemonic: 'movts',
              form: 'ALF2' as const,
              size: REAL_SHORT_FORM_SIZE,
              source: 'ALF2, 8 байт — запись/чтение банка оконной формой',
            },
          ];
    return { form: { carrier: instruction.mnemonic, commands } };
  }
  // ПРОЛОГ ЗНАЧЕНИЙ МАССИВА В ПЛОСКОСТИ ПРОЦЕДУРЫ (`src/e2k/arrayRuntime.ts#ARRAY_VALUES_CARRIER`): три
  // `movts` 0/1/8 в клетки блока. Длины берутся ИЗ ТЕХ ЖЕ команд, что понижает конвейер
  // (`arrayValuePrologue`), а база стоит в САМОМ носителе (первый операнд) — поэтому форма не зависит
  // от того, какой процедуре носитель достался (§3.130: без этой ветви раскладка отказывала
  // «формы понижения нет», и образ с блоком собирался усечённым).
  if (instruction.mnemonic === ARRAY_VALUES_CARRIER) {
    const base = instruction.operands[0];
    const commands = base?.kind === 'imm' ? arrayValuePrologue(base.value) : undefined;
    const forms = commands?.map((command) => ARRAY_COMMAND_FORMS.get(command.mnemonic) ?? printCommandForm(command));
    if (forms === undefined || forms.some((form) => form === undefined)) {
      return {
        failure: failureOf(
          LOWERING_CODES.carrier,
          `«${ARRAY_VALUES_CARRIER}»: форму пролога значений взять негде — первый операнд носителя обязан ` +
            'быть литералом базы блока (src/e2k/arrayRuntime.ts#arrayValuePrologue)',
        ),
      };
    }
    return { form: { carrier: ARRAY_VALUES_CARRIER, commands: forms.map((form) => form!) } };
  }
  if (instruction.mnemonic === ARRAY_SLOT_CARRIER) {
    // АДРЕС ЯЧЕЙКИ КУЧИ В ПЛОСКОСТИ ВЫЗЫВАЕМОЙ (A4 §3.137): ровно одна `movtd` с 64-битным литералом.
    // Длина берётся ИЗ ТОЙ ЖЕ команды, что понижает конвейер (`arraySlotPrologue`), и от плоскости не
    // зависит: литерал адреса — тот же, а форма `movtd` от номера клетки не меняется.
    const address = instruction.operands[0];
    const commands = address?.kind === 'imm64' ? arraySlotPrologue(Number(address.value)) : undefined;
    const forms = commands?.map((command) => ARRAY_COMMAND_FORMS.get(command.mnemonic) ?? printCommandForm(command));
    if (forms === undefined || forms.some((form) => form === undefined)) {
      return {
        failure: failureOf(
          LOWERING_CODES.carrier,
          `«${ARRAY_SLOT_CARRIER}»: форму шага адреса ячейки кучи взять негде — первый операнд носителя ` +
            'обязан быть 64-битным литералом адреса (src/e2k/arrayRuntime.ts#arraySlotPrologue)',
        ),
      };
    }
    return { form: { carrier: ARRAY_SLOT_CARRIER, commands: forms.map((form) => form!) } };
  }
  if (instruction.mnemonic === CALLEE_ZERO_CARRIER) {
    // НОЛЬ ВЫЗЫВАЕМОЙ ПО ПОСТРОЕНИЮ (ATOM-05-02-01, §3.166): ровно одна `movts 0` в клетку нуля.
    // Длина берётся ИЗ ТОЙ ЖЕ команды, что понижает конвейер (`calleeZeroInstructions`), а не
    // пишется числом: `movts` с непосредственным 0 кодируется КОРОТКОЙ формой, и «на глаз» здесь
    // ошибаются на восемь байт — столько стоит каждый такой носитель в образе.
    const commands = calleeZeroInstructions();
    const forms = commands.map((command) => ARRAY_COMMAND_FORMS.get(command.mnemonic) ?? printCommandForm(command));
    const missing = forms.findIndex((form) => form === undefined);
    if (missing >= 0) {
      return {
        failure: failureOf(
          LOWERING_CODES.carrier,
          `«${CALLEE_ZERO_CARRIER}»: форму команды «${commands[missing]!.mnemonic}» взять негде — ` +
            'длину ноль-клетки вызываемой раскладка обязана знать заранее (src/e2k/arrayRuntime.ts#calleeZeroInstructions)',
        ),
      };
    }
    return { form: { carrier: CALLEE_ZERO_CARRIER, commands: forms.map((form) => form!) } };
  }
  if (instruction.mnemonic === WINDOW_GROW_CARRIER) {
    return {
      form: {
        carrier: WINDOW_GROW_CARRIER,
        commands: [
          {
            mnemonic: 'setwd',
            form: 'CS1_SETWD',
            size: 16,
            source: 'измерено кодировщиком: `setwd wsz=16, nfx=0` → 16 байт (docs/hardware-debt.md §3.56.2)',
          },
          {
            mnemonic: 'setbn',
            form: 'ALF2',
            size: REAL_SHORT_FORM_SIZE,
            source: 'ALF2, 8 байт — REAL_CONTROL_OPCODES[setbn].size (src/e2k/e2k-real.ts)',
          },
        ],
      },
    };
  }
  // РАЗДЕЛЁННАЯ ПЕЧАТЬ: два носителя, чьи команды — развёртка «число → текст» и хвост `write`
  // (`src/e2k/printCall.ts`). Длины берутся из той же таблицы форм, что у сайта печати: объявление
  // и понижение обязаны считать одни байты, иначе адреса уезжают (§3.35), и это стережёт оракул.
  if (instruction.mnemonic === PRINT_TEXT_CARRIER) {
    const forms = printCarrierForms(printTextInstructions(context.heapAddress ?? PRINT_HEAP_BY_CONVENTION));
    if (typeof forms === 'string') return { failure: failureOf(LOWERING_CODES.print, forms) };
    return { form: { carrier: PRINT_TEXT_CARRIER, commands: forms } };
  }
  if (instruction.mnemonic === EXIT_CARRIER) {
    const value = instruction.operands[1];
    const forms = printCarrierForms(
      exitCarrierInstructions(0, value?.kind === 'reg' ? value.index : undefined),
    );
    if (typeof forms === 'string') return { failure: failureOf(LOWERING_CODES.print, forms) };
    return { form: { carrier: EXIT_CARRIER, commands: forms } };
  }
  if (instruction.mnemonic === PRINT_WRITE_CARRIER) {
    const forms = printCarrierForms(
      printWriteInstructions(context.heapAddress ?? PRINT_HEAP_BY_CONVENTION, frame),
    );
    if (typeof forms === 'string') return { failure: failureOf(LOWERING_CODES.print, forms) };
    return { form: { carrier: PRINT_WRITE_CARRIER, commands: forms } };
  }
  // ОСТАТОК: понижение — СЕРИЯ из трёх команд (`src/e2k/remainderRuntime.ts`), поэтому форма
  // берётся из ТОГО ЖЕ источника команд, что и понижение: разойдись они — раскладка посчитала бы
  // один носитель, а в образ ушло три команды, и адреса уехали бы молча (§3.35).
  if (instruction.mnemonic === REMAINDER_CARRIER) {
    const operands = instruction.operands;
    const a = operands[1];
    const b = operands[2];
    const d = operands[0];
    if (a?.kind !== 'reg' || b?.kind !== 'reg' || d?.kind !== 'reg') {
      return {
        failure: failureOf(
          LOWERING_CODES.carrier,
          '«IR.rem»: операнды обязаны быть регистрами (делимое, делитель, приёмник)',
        ),
      };
    }
    const forms = printCarrierForms(remainderInstructions(a.index, b.index, d.index));
    if (typeof forms === 'string') return { failure: failureOf(LOWERING_CODES.carrier, forms) };
    return { form: { carrier: REMAINDER_CARRIER, commands: forms } };
  }
  // `IR.const` — единственный носитель, чья длина зависит от ЗНАЧЕНИЯ (литерал из пула), поэтому
  // форма берётся отдельной ветвью, а не из статической таблицы CARRIER_FORMS.
  if (instruction.mnemonic === 'IR.const') return { form: constForm(instruction, context) };
  // СРАВНЕНИЕ, ЗНАЧЕНИЕ КОТОРОГО НУЖНО ЕЩЁ И КАК ЗНАЧЕНИЕ (срез A4-5а): у него длина не одной
  // команды, а трёх — само сравнение плюс два переноса 0/1 под предикатом (материализация).
  // Признак — пометка сопоставления (`pairPredicates`); она же читается понижением, поэтому форма
  // и байты берутся из ОДНОГО решения и разойтись не могут. Без пометки — прежняя статическая форма
  // (8 байт), поэтому закреплённые числа пяти ядер не двигаются.
  if (comparisonMnemonicOf(instruction.mnemonic) !== undefined && isMaterializingComparison(instruction)) {
    const staticForm = carrierForm(instruction.mnemonic);
    if (staticForm === undefined) return {};
    return {
      form: {
        carrier: instruction.mnemonic,
        commands: [
          ...staticForm.commands,
          { mnemonic: 'movts', form: 'ALF2 + CDS (psrc)', size: REAL_LONG_FORM_SIZE, source: COMPARISON_VALUE_COMMAND_SOURCE },
          { mnemonic: 'movts', form: 'ALF2 + CDS (psrc, ~%predN)', size: REAL_LONG_FORM_SIZE, source: COMPARISON_VALUE_COMMAND_SOURCE },
        ],
      },
    };
  }
  // ПЕРЕХОД, ВЕТВЯЩИЙСЯ ПО ЗНАЧЕНИЮ (A4, срез 5г): у «склейки» с двумя разными рёбрами длина не двух
  // команд, а трёх — `disp` и `ct` плюс сравнение значения с нулём (`cmpesb`). Признак — пометка
  // сопоставления (`pairPredicates`), она же читается понижением, поэтому форма и байты — из ОДНОГО
  // решения. Порядок команд тот же, что у `valueBranchJumpCommands`: смещение ПЕРВОЙ командой, иначе
  // `secondPass` отсчитывал бы его не от начала носителя.
  if (CONDITIONAL_JUMP_CARRIERS.includes(instruction.mnemonic) && isValueBranchJump(instruction)) {
    const jumpForm = carrierForm(instruction.mnemonic);
    const compareForm = carrierForm(VALUE_BRANCH_COMPARISON);
    if (jumpForm === undefined || compareForm === undefined) return {};
    const displacement = jumpForm.commands[0];
    const branch = jumpForm.commands[1];
    const compare = compareForm.commands[0];
    if (displacement === undefined || branch === undefined || compare === undefined) return {};
    return {
      form: {
        carrier: instruction.mnemonic,
        commands: [displacement, compare, branch],
      },
    };
  }
  if (instruction.mnemonic === 'IR.call') return callForm(instruction);
  if (instruction.mnemonic === 'IR.ret') return retForm(instruction, context.procedureReturn === true);
  if (instruction.mnemonic !== 'IR.invoke') {
    const form = carrierForm(instruction.mnemonic);
    return form === undefined ? {} : { form };
  }
  const names = context.invokeNames;
  if (names === undefined) {
    return {
      failure: failureOf(
        LOWERING_CODES.carrier,
        '«IR.invoke»: не передан список имён хост-вызовов образа (`invokeNames`) — `payload` носителя ' +
          'это индекс в нём, и длину понижения (одна команда у «длина», девять у «добавить») взять негде',
      ),
    };
  }
  const payload = instruction.operands[3];
  const flags = instruction.operands[0];
  if (payload === undefined || payload.kind !== 'imm' || flags === undefined || flags.kind !== 'imm') {
    return {
      failure: failureOf(LOWERING_CODES.carrier, '«IR.invoke»: операнды носителя не той формы (ожидались flags и payload числами)'),
    };
  }
  const name = names[payload.value];
  if (name === undefined) {
    return {
      failure: failureOf(
        LOWERING_CODES.carrier,
        `«IR.invoke»: в таблице имён нет записи с индексом ${payload.value} (всего имён ${names.length})`,
      ),
    };
  }
  const hasDestination = (flags.value & 1) === 1;
  const destination = instruction.operands[4];
  // Аргументы — ОДНИМ источником: третий лежит в поле `src3`, а не следом за вторым.
  const args = callArgumentOperands(instruction);
  // ── ПЕЧАТЬ: третий рантайм, и он единственный, чья длина — СОТНИ байт ──────────────────────────
  //
  // Развёртка «число → текст → `write`» (`src/e2k/printPrimitives.ts`, измерена: docs/hardware-debt.md
  // §3.40) понижается не парой команд, а ~150. Раскладка обязана знать эту длину: иначе смещение
  // перехода, пересекающего печать, считается по нулю и уводит поток — измерено на записи
  // `43-печать-в-цикле`, у которой печать стоит В ТЕЛЕ цикла и её пересекают оба перехода.
  //
  // Длину сайта раскладка собирает из той же таблицы форм, что и у рантаймов массивов и математики
  // ({@link printCommandForm}), плюс сохранение живых регистров вокруг печати: развёртка занимает
  // `%b[0..11]` целиком, поэтому вызывающий сохраняет то, что ему нужно после неё, носителями
  // вытеснения (по 48 байт на регистр — `movtd`+`std` и `movtd`+`ldd`). Число сохранённых несёт сам
  // носитель (`printSaveCountOf`): раскладка видит только его.
  if (isPrintCallName(name)) {
    const argument = instruction.operands[1];
    if (argument === undefined || argument.kind !== 'reg') {
      return {
        failure: failureOf(LOWERING_CODES.print, `«${name}»: значение не в регистре — развёртка печати берёт его из регистра`),
      };
    }
    // ── ПЕЧАТЬ СТРОКИ ────────────────────────────────────────────────────────────────────────────
    // У строки нет развёртки: байты уже лежат в образе, длина известна, и команды — «адрес и длина в
    // аргументы `write`, затем перевод строки вторым вызовом» (`src/e2k/stringRuntime.ts`). Признак —
    // вторая пометка носителя (у печати ЧИСЛА её нет: там шестой операнд — число сохраняемых регистров,
    // и он один). Команды берутся из ТОГО ЖЕ модуля, что и у понижения: разойтись нечем.
    if (isStringPrint(instruction)) {
      const marks = stringMarksOf(instruction);
      const [byteLength, newlineAddress, saveCount = 0] = marks;
      if (byteLength === undefined || newlineAddress === undefined) {
        return {
          failure: failureOf(
            LOWERING_CODES.print,
            `«${name}»: печать строки без длины или без адреса перевода строки — пометки ставит конвейер ` +
              '(src/e2k/stringPlan.ts)',
          ),
        };
      }
      const commands = stringWriteInstructions({
        address: argument.index,
        byteLength,
        newlineAddress,
        frame,
      });
      const forms: CommandForm[] = [];
      for (const command of commands) {
        const form = printCommandForm(command);
        if (form === undefined) {
          return {
            failure: failureOf(
              LOWERING_CODES.print,
              `«${name}»: у команды вывода строки «${command.mnemonic}» нет формы — длину взять негде`,
            ),
          };
        }
        forms.push({ mnemonic: form.mnemonic, form: form.form, size: form.size, source: form.source });
      }
      if (saveCount > 0) forms.push(saveForm(saveCount));
      return { form: { carrier: 'IR.invoke', commands: forms } };
    }
    const saveCount = printSaveCountOf(instruction);
    if (saveCount === undefined) {
      return {
        failure: failureOf(
          LOWERING_CODES.print,
          `«${name}»: носитель не несёт число сохраняемых через печать регистров (операнд ` +
            `${String(PRINT_SAVE_COUNT_OPERAND)}) — его ставит конвейер (src/e2k/programImage.ts), и без него ` +
            'длину сайта печати взять негде',
        ),
      };
    }
    const printing: CommandForm[] = [];
    for (const command of printCallInstructions(
      argument.index,
      context.heapAddress ?? PRINT_HEAP_BY_CONVENTION,
      frame,
    )) {
      const form = printCommandForm(command);
      if (form === undefined) {
        return {
          failure: failureOf(
            LOWERING_CODES.print,
            `«${name}»: у команды развёртки «${command.mnemonic}» нет формы в таблице раскладки — ` +
              'длину взять негде (таблица — src/e2k/printCall.ts:printCommandForm)',
          ),
        };
      }
      printing.push({ mnemonic: form.mnemonic, form: form.form, size: form.size, source: form.source });
    }
    if (saveCount > 0) printing.push(saveForm(saveCount));
    return { form: { carrier: 'IR.invoke', commands: printing } };
  }
  // ── СТРОКИ: `длина` и `объединить` ─────────────────────────────────────────────────────────────
  //
  // Строковый рантайм (`src/e2k/stringRuntime.ts`) — третий, и он тоже разворачивается в десятки
  // команд: проход по байтам за длиной в кодпоинтах и копирование байтов при склейке. Длину
  // раскладка берёт из ТОЙ ЖЕ функции, что и понижение, а числа (сколько байт у строки, где таблица,
  // где буфер) — из пометок носителя, которые ставит конвейер ДО раскладки (`src/e2k/stringPlan.ts`).
  if (name === STRING_CALLS.length || name === STRING_CALLS.concat || name === STRING_CALLS.symbol) {
    const marks = stringMarksOf(instruction);
    const destinationRegister = hasDestination && destination?.kind === 'reg' ? destination.index : undefined;
    const argumentRegister = instruction.operands[1];
    if (argumentRegister === undefined || argumentRegister.kind !== 'reg' || destinationRegister === undefined) {
      return {
        failure: failureOf(LOWERING_CODES.runtime, `«${name}»: строковая операция требует регистров аргумента и приёмника`),
      };
    }
    let commands: readonly AsmInstruction[];
    if (name === STRING_CALLS.symbol) {
      const [codePoints, tableAddress] = marks;
      const indexRegister = instruction.operands[2];
      if (codePoints === undefined || tableAddress === undefined || indexRegister?.kind !== 'reg') {
        return {
          failure: failureOf(
            LOWERING_CODES.runtime,
            `«${name}»: носитель не несёт число кодпоинтов, адрес таблицы кодов или регистр индекса — их ставит ` +
              'конвейер (src/e2k/stringPlan.ts)',
          ),
        };
      }
      commands = stringSymbolInstructions({
        index: indexRegister.index,
        destination: destinationRegister,
        codePoints,
        tableAddress,
      });
    } else if (name === STRING_CALLS.length) {
      const [byteLength, tableAddress] = marks;
      if (byteLength === undefined || tableAddress === undefined) {
        return {
          failure: failureOf(
            LOWERING_CODES.runtime,
            `«${name}»: носитель не несёт длину строки в байтах или адрес таблицы продолжений — их ставит ` +
              'конвейер (src/e2k/stringPlan.ts)',
          ),
        };
      }
      commands = stringLengthInstructions({
        base: argumentRegister.index,
        byteLength,
        destination: destinationRegister,
        tableAddress,
      });
    } else {
      const [firstBytes, secondBytes, bufferAddress] = marks;
      const second = instruction.operands[2];
      if (firstBytes === undefined || secondBytes === undefined || bufferAddress === undefined || second?.kind !== 'reg') {
        return {
          failure: failureOf(
            LOWERING_CODES.runtime,
            `«${name}»: носитель не несёт длины склеиваемых строк или адрес буфера — их ставит конвейер ` +
              '(src/e2k/stringPlan.ts)',
          ),
        };
      }
      commands = stringConcatInstructions({
        first: argumentRegister.index,
        second: second.index,
        destination: destinationRegister,
        bufferAddress,
        firstBytes,
        secondBytes,
      });
    }
    const forms: CommandForm[] = [];
    for (const command of commands) {
      const form = printCommandForm(command);
      if (form === undefined) {
        return {
          failure: failureOf(
            LOWERING_CODES.runtime,
            `«${name}»: у команды строкового рантайма «${command.mnemonic}» нет формы в таблице — длину взять негде`,
          ),
        };
      }
      forms.push({ mnemonic: form.mnemonic, form: form.form, size: form.size, source: form.source });
    }
    return { form: { carrier: 'IR.invoke', commands: forms } };
  }
  const lowered = ((): readonly AsmInstruction[] | string => {
    try {
      // ТРИ рантайма по имени вызова — так же, как в понижении (`src/e2k/e2kRealRun.ts`): массивы
      // (`src/e2k/arrayRuntime.ts`), математика (`src/e2k/mathRuntime.ts`, остаток через `SMODX`) и
      // коллекции на `brk` (`src/e2k/collectionsRuntime.ts` — база блока берётся у границы кучи).
      // Длина понижения берётся из формы его команд, поэтому раскладка обязана знать все три: иначе
      // вызов отвергается ещё до понижения.
      return SUPPORTED_MATH_CALLS.includes(name)
        ? lowerMathCall(name, args, hasDestination && destination?.kind === 'reg' ? destination.index : undefined)
        : COLLECTION_CALL_NAMES.includes(name)
          ? lowerCollectionCall(name, args, hasDestination && destination?.kind === 'reg' ? destination.index : undefined)
          // Рантайму массивов здесь нужна ТОЛЬКО длина (§3.130): `forForm` снимает семантические
          // сторожа (базу блока и недоступность кучи в вызываемой) — их держит понижение, а раскладке
          // длина нужна раньше её. Прежде сторожа звались и отсюда, и вызов отвергался ДО понижения:
          // так правка §3.128 получила 4–7 отказов на образ и «пустую программу» вместо замера.
          : lowerArrayCall(
              name,
              args,
              hasDestination && destination?.kind === 'reg' ? destination.index : undefined,
              { forForm: true },
            );
    } catch (error) {
      return error instanceof Error ? error.message : String(error);
    }
  })();
  if (typeof lowered === 'string') return { failure: failureOf(LOWERING_CODES.runtime, lowered) };
  const commands: CommandForm[] = [];
  for (const command of lowered) {
    // ДВЕ таблицы форм, а не одна: рантайм коллекций собран из команд ДВУХ семейств — адресной
    // арифметики рантайма массивов (`addd`, `std` — ADDD/ARRAY_COMMAND_FORMS) и системного вызова
    // (`setbn`, `sdisp`, `movts`, `call` — printCommandForm, чьи размеры сверены с `as-new` побайтово,
    // §3.40.5). Пересечение у таблиц одно (`ldd`, `std`) и размеры в нём совпадают; расхождение
    // поймал бы оракул сверки форм, поэтому «вторая таблица» здесь названа, а не спрятана.
    const form = ARRAY_COMMAND_FORMS.get(command.mnemonic) ?? printCommandForm(command);
    if (form === undefined) {
      return {
        failure: failureOf(
          LOWERING_CODES.carrier,
          `«${name}»: у команды понижения «${command.mnemonic}» нет формы в таблице раскладки — ` +
            'длину взять негде (в рантаймах массивов, математики и коллекций таких команд быть не должно)',
        ),
      };
    }
    commands.push({ mnemonic: form.mnemonic, form: form.form, size: form.size, source: form.source });
  }
  return { form: { carrier: 'IR.invoke', commands } };
}

/**
 * Форма понижения носителя **с учётом операндов**.
 *
 * Нужна там, где длина зависит не только от мнемоники: `IR.invoke` понижается в 1, 3, 6 или 9 команд
 * в зависимости от имени вызова (измерено `.tmp/invoke-names.ts`). Размеры команд берутся из таблицы
 * форм, а не из пробного кодирования: раскладка обязана быть независима от кодировщика, иначе
 * расхождение между ними нечем поймать (`src/e2k/twoPassLayout.ts`: так же устроены остальные формы).
 */
export function carrierFormOf(
  instruction: AsmInstruction,
  context: CarrierFormContext = {},
): CarrierForm | undefined {
  return carrierFormWithReason(instruction, context).form;
}

/** Размер носителя в байтах; `undefined` — формы нет. */
export function sizeOfCarrier(carrier: string): number | undefined {
  const form = carrierForm(carrier);
  if (form === undefined) return undefined;
  return form.commands.reduce((sum, command) => sum + command.size, 0);
}

/**
 * РАЗМЕР ШИРОКОЙ КОМАНДЫ в байтах — по её форме, а не по сумме размеров отдельных команд.
 *
 * # Почему не «число слогов × 8»
 *
 * Команда e2k — это контейнер, а не набор: её длину задаёт структура
 * (`src/e2k/widePacker.ts:110-144`, `docs/e2k-wide-commands.md` §2.2, §2.5):
 *
 * ```
 * слова = добивка_до_чётного(1 + N + ceil(ALES / 2))
 * байт  = слова × 4
 * ```
 *
 * где `1` — заголовочный слог HS, `N` — слоги ALS по 4 байта, `ALES` — полуслоги по 2 байта,
 * которые делят слово **по двое** (`widePacker.ts:123-127`), а добивка до чётного числа слов — из
 * `gas/config/tc-e2k.c:9488-9492` (`widePacker.ts:129`).
 *
 * Поэтому «N × 8» неверно уже на трёх слогах: `HS + 3 ALS = 4 слова = 16 байт`, а не 24
 * (`src/e2k/widePackets.test.ts:73-74`). Выравнивание даёт нечётный шаг: 3 и 5 слогов стоят
 * столько же, сколько 4 и 6.
 *
 * Формула сверена с кодировщиком оракулом `src/e2k/packetSize.test.ts`: там числа байт измеряет
 * сам `packWide`, а не пересказ этой формулы.
 *
 * @param slots слогов ALS в команде (не меньше одного)
 * @param ales сколько из них несут полуслог ALES (длинная форма); не больше `slots`
 * @throws Error если форма невыразима: ноль слогов, полуслогов больше, чем слогов, либо длина
 *   вышла за предел поля `lng` (3 бита — 8 слов, `widePacker.ts:133`). Последний случай не
 *   гипотетический: шесть слогов с двумя и более длинными формами дают 10 слов = 40 байт, и такая
 *   команда невыразима вовсе. Молча вернуть 40 значило бы отдать раскладке размер, которого у
 *   команды быть не может.
 */
export function sizeOfWideGroup(slots: number, ales: number): number {
  if (!Number.isInteger(slots) || slots < 1) {
    throw new Error(`широкая команда: слогов ${String(slots)} — команда без слогов невыразима`);
  }
  if (!Number.isInteger(ales) || ales < 0) {
    throw new Error(`широкая команда: полуслогов ${String(ales)} — число не может быть отрицательным`);
  }
  if (ales > slots) {
    throw new Error(
      `широкая команда: полуслогов ${ales} больше, чем слогов ${slots} — ` +
        'полуслог ALES принадлежит слогу ALS и без него не существует',
    );
  }
  // HS + N слогов ALS + слова полуслогов, затем добивка до чётного числа 4-байтовых слогов.
  const words = 1 + slots + Math.ceil(ales / 2);
  const padded = words % 2 === 0 ? words : words + 1;
  if (padded > MAX_WIDE_WORDS) {
    throw new Error(
      `широкая команда: ${padded} слов (${padded * 4} байт) при ${slots} слогах и ${ales} длинных — ` +
        `предел поля lng ${MAX_WIDE_WORDS} слов; форма невыразима (src/e2k/widePacker.ts:133)`,
    );
  }
  return padded * 4;
}

/**
 * Предел длины широкой команды в 4-байтовых словах: поле `lng` занимает три бита
 * (`widePacker.ts:133` — `lng = words / 2 - 1`, маска `0x7`), то есть не больше 8 слов = 32 байта.
 */
export const MAX_WIDE_WORDS = 8;

// ─────────────────────────────────────────────────────────────────────────────
// КОМАНДЫ ПЕРЕХОДА
// ─────────────────────────────────────────────────────────────────────────────

/** `%ctpr`, которым выполняется передача управления. Наше решение: все переходы через `%ctpr1`. */
export const JUMP_CTPR = 1;

/** Носитель **безусловного** перехода: `ct` у него передаёт управление всегда. */
export const JUMP_CARRIER = "IR.jmp";

/** Носители условных переходов: их `ct` читает предикат, поставленный сравнением. */
export const CONDITIONAL_JUMP_CARRIERS: readonly string[] = ["IR.jmp_if", "IR.jmp_if_not"];

/** Все носители переходов: смещение `disp` считается для каждого из них одинаково. */
export const JUMP_CARRIERS: readonly string[] = [JUMP_CARRIER, ...CONDITIONAL_JUMP_CARRIERS];

/** Является ли носитель переходом (любым). */
export function isJumpCarrier(mnemonic: string): boolean {
  return JUMP_CARRIERS.includes(mnemonic);
}

/**
 * Команды пары перехода: `disp %ctpr1, <смещение>` (CS0) и `ct %ctpr1[, ? {~}%predN]` (SS).
 *
 * Смещение передаётся уже **в 8-байтных единицах** — так его и несёт поле `disp[27:0]`.
 * Форма пары — предмет раскладки (она её измеряет), поэтому конструктор живёт здесь;
 * понижение (`src/e2k/e2kRealRun.ts`) берёт готовую пару, а не собирает её заново.
 *
 * У **условного** перехода в `ct` стоит код условия (`SS.ctcond`) вместо «всегда»: `0x40` — по
 * предикату, `0x60` — по инверсному (`gas/config/tc-e2k.c:4589-4591`). Второй аргумент —
 * именно код условия, а не флаг: полярность выводит сопоставление
 * (`src/e2k/predicatePairing.ts`), раскладка её не пересчитывает.
 */
export function jumpCommands(disp: number, condition: number = CT_COND_ALWAYS): readonly AsmInstruction[] {
  return [
    { mnemonic: "disp", channel: 0, operands: [imm(JUMP_CTPR), imm(disp)] },
    { mnemonic: "ct", channel: 0, operands: [imm(JUMP_CTPR), imm(condition)] },
  ];
}

/**
 * Команды перехода, ветвящегося ПО ЗНАЧЕНИЮ — «склейки» с двумя разными рёбрами (A4, срез 5г).
 *
 * ```
 * disp %ctpr1, <смещение>          адрес цели — ПЕРВОЙ командой (так его считает `secondPass`)
 * cmp esb <значение>, <НОЛЬ>, %pred «значение равно нулю» — предикат из значения
 * ct   %ctpr1, ? %pred             скачок, когда значение равно нулю
 * ```
 *
 * `cmpesb` — табличное «равно» (`comparisonMnemonicOf`), поэтому предикат истинен ровно при
 * `значение == 0`: `jmp_if_not` скачет по нему (`CTC OND_PRED`), `jmp_if` — по инверсному
 * (`CTC OND_NEG_PRED`). Код условия строит понижение (оно знает имя носителя), раскладка берёт
 * только ФОРМУ — как у всякой пары.
 *
 * ПОРЯДОК КОМАНД НЕ СЛУЧАЕН: `disp` остаётся первым, иначе `secondPass` отсчитывал бы смещение от
 * команды сравнения. Расстояние `disp` → `ct` здесь на одну команду больше обычного, и для пары
 * `disp`/`ct` это безразлично: обе — отдельные команды, а `ctpr` живёт между ними.
 */
export function valueBranchJumpCommands(
  disp: number,
  value: Operand,
  zero: Operand,
  condition: number,
): readonly AsmInstruction[] {
  const [displacement, branch] = jumpCommands(disp, condition);
  return [
    displacement!,
    {
      mnemonic: comparisonMnemonicOf(VALUE_BRANCH_COMPARISON)!.mnemonic,
      channel: 0,
      operands: [value, zero, { kind: "pred", index: PREDICATE_FOR_PAIRS }],
    },
    branch!,
  ];
}

// ─────────────────────────────────────────────────────────────────────────────
// ПЕРВЫЙ ПРОХОД — АДРЕСА
// ─────────────────────────────────────────────────────────────────────────────

/** Размещённая инструкция. */
export interface LayoutEntry {
  /** Индекс в потоке носителей (он же индекс инструкции IR: эмиттер ставит их один к одному). */
  readonly index: number;
  /** Адрес первой команды в байтах от начала образа. */
  readonly address: number;
  /** Сколько байт занимает инструкция со всеми своими командами. */
  readonly size: number;
  /** Носитель IR. */
  readonly carrier: string;
  /**
   * Команды в порядке выдачи.
   *
   * У **широкой команды** список пуст: она не разлагается на команды таблицы форм, её размер даёт
   * {@link sizeOfWideGroup}, а форма лежит в {@link LayoutEntry.wideGroup}. Это не «забыли
   * заполнить»: пустой список у записи с `wideGroup` — признак того, что размер посчитан по
   * структуре команды, а не по сумме форм.
   */
  readonly commands: readonly CommandForm[];
  /** Форма широкой команды, если эта запись — широкая команда, а не носитель. */
  readonly wideGroup?: WideGroupShape;
}

/** Инструкция, которой адрес не присвоен, и почему — с КОДОМ отказа (`OSN-LOW-*`). */
export interface UnplacedInstruction {
  readonly index: number;
  readonly carrier: string;
  /** Личность отказа: код контракта, а не текст причины. */
  readonly code: LoweringRefusalCode;
  readonly reason: string;
}

/** Полная раскладка: и то, что размещено, и то, что нет. */
export interface LayoutTable {
  readonly entries: readonly LayoutEntry[];
  readonly unplaced: readonly UnplacedInstruction[];
  /** Индекс → адрес. */
  readonly addresses: ReadonlyMap<number, number>;
  /** Размер образа: сумма размеров размещённых инструкций. */
  readonly totalBytes: number;
}

/** Причина, по которой у носителя нет адреса. */
function unplacedReason(carrier: string): string {
  if (!carrier.startsWith("IR.")) {
    return `«${carrier}» — не носитель IR: раскладка идёт по потоку носителей оболочки`;
  }
  return (
    `«${carrier}»: формы понижения нет — инструкция не размещается и в образ не попадает ` +
    `(причины по носителям — REFUSALS в src/e2k/e2kRealRun.ts; почему форма не снимается — ` +
    `docs/e2k-real-run.md §2.2)`
  );
}

/**
 * Разложить поток носителей: адрес и размер каждой инструкции, у которой есть форма.
 *
 * Размер берётся из {@link CARRIER_FORMS} по носителю — **не** из пробного кодирования: раскладка
 * обязана быть независима от кодировщика, иначе расхождение между ними нечем поймать.
 */
export function layoutOf(
  instructions: readonly AsmInstruction[],
  context: CarrierFormContext = {},
): LayoutTable {
  const entries: LayoutEntry[] = [];
  const unplaced: UnplacedInstruction[] = [];
  const addresses = new Map<number, number>();
  // Носители, которые в образ НЕ ПОПАДАЮТ (возвраты точки входа: их место занимает её `exit`),
  // получают размер 0 — иначе раскладка резервирует байты под то, чего в образе не будет, и адреса
  // всего, что стоит дальше, уезжают. Список приходит от конвейера: он знает, чьи это возвраты.
  const zeroSize = new Set(context.zeroSize ?? []);
  // ПОМЕТКИ МАТЕРИАЛИЗАЦИИ — ДО ФОРМ. Длина носителя сравнения зависит от того, нужно ли его значение
  // ещё и как значение, а решает это сопоставление пар (`pairPredicates`) — единственное место, где
  // судьба пары известна целиком. Форму раскладка берёт заранее и без плоскости (§3.135), поэтому
  // признак обязан стоять на самом носителе: пометку сопоставление кладёт по тождеству объекта, а
  // читают её и раскладка (здесь), и понижение — разойтись им нечем.
  pairPredicates(instructions);
  let offset = 0;
  instructions.forEach((instruction, index) => {
    if (zeroSize.has(index)) {
      entries.push({ index, address: offset, size: 0, carrier: instruction.mnemonic, commands: [] });
      addresses.set(index, offset);
      return;
    }
    // Широкая команда — не носитель и не форма: её размер задаёт структура (HS + слоги + добивка),
    // и в `CARRIER_FORMS` её нет и быть не может, потому что она собирается из нескольких команд.
    if (instruction.wideGroup !== undefined) {
      const size = sizeOfWideGroup(instruction.wideGroup.slots, instruction.wideGroup.ales);
      entries.push({
        index,
        address: offset,
        size,
        carrier: instruction.mnemonic,
        commands: [],
        wideGroup: instruction.wideGroup,
      });
      addresses.set(index, offset);
      offset += size;
      return;
    }
    const outcome = carrierFormWithReason(instruction, context);
    if (outcome.form === undefined) {
      // Причина называется своя, если она известна (например, у `IR.invoke` без имён хост-вызовов):
      // общая отговорка «формы понижения нет» на этом месте врала бы — форма есть, её негде взять.
      // Код берётся у той же причины: нет формы — `OSN-LOW-001`, а у своего отказа свой код.
      unplaced.push({
        index,
        carrier: instruction.mnemonic,
        code: outcome.failure?.code ?? LOWERING_CODES.noForm,
        reason: outcome.failure?.reason ?? unplacedReason(instruction.mnemonic),
      });
      return;
    }
    const form = outcome.form;
    const size = form.commands.reduce((sum, command) => sum + command.size, 0);
    entries.push({
      index,
      address: offset,
      size,
      carrier: instruction.mnemonic,
      commands: form.commands,
    });
    addresses.set(index, offset);
    offset += size;
  });
  return { entries, unplaced, addresses, totalBytes: offset };
}

/**
 * Первый проход: `индекс → адрес в байтах`.
 *
 * Адреса монотонно возрастают без пропусков и пересечений: каждая следующая инструкция начинается
 * ровно там, где кончается предыдущая (сумма размеров, шаг — размер этой инструкции).
 */
export function firstPass(instructions: readonly AsmInstruction[]): Map<number, number> {
  return new Map(layoutOf(instructions).addresses);
}

// ─────────────────────────────────────────────────────────────────────────────
// ВТОРОЙ ПРОХОД — СМЕЩЕНИЯ
// ─────────────────────────────────────────────────────────────────────────────

/** Вычисленное смещение перехода. */
export interface Displacement {
  /** Индекс инструкции перехода в потоке. */
  readonly index: number;
  /** Индекс цели перехода в потоке. */
  readonly targetIndex: number;
  /** Адрес команды `disp` — от него отсчитывается смещение. */
  readonly commandAddress: number;
  /** Адрес цели. */
  readonly targetAddress: number;
  /** Смещение в 8-байтных единицах: `(targetAddress − commandAddress) / 8`. */
  readonly disp: number;
}

/** Отказ второго прохода: переход, которому смещение не вычислено — с кодом контракта. */
export interface DisplacementRefusal {
  readonly index: number;
  /** Личность отказа: `OSN-LOW-004`, если не хватило раскладки, и `OSN-LOW-007`/`001`, если виноват носитель. */
  readonly code: LoweringRefusalCode;
  readonly reason: string;
}

/** Результат второго прохода. */
export interface SecondPassResult {
  /** Поток с подставленным смещением у разрешённых переходов. */
  readonly instructions: readonly AsmInstruction[];
  readonly displacements: readonly Displacement[];
  readonly refusals: readonly DisplacementRefusal[];
}

/** Проверить смещение на разрядность; `undefined` — влезает. */
function dispRangeProblem(disp: number): string | undefined {
  if (disp >= DISP_MIN && disp <= DISP_MAX) return undefined;
  return (
    `смещение disp = ${disp} не влезает в ${DISP_BITS}-битное знаковое поле C0F2.disp[27:0] ` +
    `(${DISP_MIN}..${DISP_MAX} в 8-байтных единицах): ${DISP_SOURCE}`
  );
}

/**
 * Второй проход: вычислить смещения переходов по готовым адресам.
 *
 * `disp = (адрес цели − адрес команды) / 8`. Проверяются: цель существует в потоке, цель
 * **размещена** (у неё есть форма), разность адресов кратна 8 и смещение влезает в поле. Каждый
 * отказ назван причиной — выдуманного адреса не бывает.
 */
export function secondPass(
  instructions: readonly AsmInstruction[],
  addresses: ReadonlyMap<number, number>,
): SecondPassResult {
  const resolved = [...instructions];
  const displacements: Displacement[] = [];
  const refusals: DisplacementRefusal[] = [];

  instructions.forEach((instruction, index) => {
    if (!isJumpCarrier(instruction.mnemonic)) return;
    const refuse = (code: LoweringRefusalCode, reason: string): void => {
      refusals.push({ index, code, reason: `«${instruction.mnemonic}» #${index}: ${reason}` });
    };
    // Позиция цели в носителе: у `IR.jmp` она первая, у условного перехода — вторая (первая
    // занята регистром-условием: носитель несёт `(cond, off)`, src/e2k/emitterShell.ts).
    const targetAt = instruction.mnemonic === JUMP_CARRIER ? 0 : 1;
    const operand = instruction.operands[targetAt];
    if (operand === undefined || operand.kind !== "imm" || !Number.isInteger(operand.value)) {
      refuse(LOWERING_CODES.carrier, `цель перехода не выражена числом — операция несёт ${operand?.kind ?? "ничего"}`);
      return;
    }
    const targetIndex = operand.value;
    if (targetIndex < 0 || targetIndex >= instructions.length) {
      refuse(LOWERING_CODES.carrier, `цель перехода #${targetIndex} вне потока (инструкций ${instructions.length})`);
      return;
    }
    const commandAddress = addresses.get(index);
    if (commandAddress === undefined) {
      refuse(LOWERING_CODES.noForm, `команда не размещена — у «${instruction.mnemonic}» нет формы понижения`);
      return;
    }
    const targetAddress = addresses.get(targetIndex);
    if (targetAddress === undefined) {
      refuse(
        LOWERING_CODES.noForm,
        `цель перехода #${targetIndex} (${instructions[targetIndex]!.mnemonic}) не размещена — ` +
          `у неё нет формы понижения, адрес цели неизвестен`,
      );
      return;
    }
    const delta = targetAddress - commandAddress;
    if (delta % DISP_UNITS !== 0) {
      refuse(
        LOWERING_CODES.layout,
        `разность адресов ${delta} не кратна ${DISP_UNITS}: смещение выражается только в ` +
          `восьмибайтовых словах (syllab-format.h:100)`,
      );
      return;
    }
    const disp = delta / DISP_UNITS;
    const problem = dispRangeProblem(disp);
    if (problem !== undefined) {
      refuse(LOWERING_CODES.layout, problem);
      return;
    }
    // Смещение подставляется В ЦЕЛЬ, а прочие операнды не трогаются: у условного перехода
    // регистр-условие обязан остаться на месте, иначе сопоставление потеряет связь пары.
    const operands = instruction.operands.map((item, at) => (at === targetAt ? imm(disp) : item));
    resolved[index] = { ...instruction, operands };
    displacements.push({ index, targetIndex, commandAddress, targetAddress, disp });
  });

  return { instructions: resolved, displacements, refusals };
}
