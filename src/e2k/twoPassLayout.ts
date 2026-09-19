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

import type { AsmInstruction, Operand } from "./backend";
import { CT_COND_ALWAYS, REAL_LONG_FORM_SIZE, REAL_SHORT_FORM_SIZE } from "./e2k-real";
import { lowerArrayCall } from "./arrayRuntime";

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
    carrier: "IR.add",
    commands: [{ mnemonic: "adds", form: "ALF1", size: REAL_SHORT_FORM_SIZE, source: SHORT_SOURCE }],
  },
  {
    carrier: "IR.sub",
    commands: [{ mnemonic: "subs", form: "ALF1", size: REAL_SHORT_FORM_SIZE, source: SHORT_SOURCE }],
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
 * Формы команд рантайма массивов: `adds`, `ldd`, `std` — все ALF1, по 8 байт.
 *
 * Рантайм выражает вызовы массивов **только** этими командами и только регистрами (литералов в них
 * нет: `src/e2k/arrayRuntime.ts`, `timesEight` — три `adds`). Размеры всё равно берутся из формы, а не
 * из арифметики «сколько байт мне кажется»: оракул сверяет их с кодировщиком.
 */
const ARRAY_COMMAND_FORMS: ReadonlyMap<string, CommandForm> = new Map([
  ['adds', { mnemonic: 'adds', form: 'ALF1', size: REAL_SHORT_FORM_SIZE, source: SHORT_SOURCE }],
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

/** Где в операндах носителя лежат признаки вызова: `flags = (есть приёмник) | (аргументов << 1)`. */
function callFlags(instruction: AsmInstruction): { argc: number; hasDestination: boolean } | undefined {
  const flags = instruction.operands[0];
  if (flags === undefined || flags.kind !== 'imm') return undefined;
  return { argc: flags.value >> 1, hasDestination: (flags.value & 1) === 1 };
}

/** Форма вызова: пересылки аргументов в окно вызываемого + `disp` + `call` + чтение результата. */
function callForm(instruction: AsmInstruction): { form?: CarrierForm; reason?: string } {
  const flags = callFlags(instruction);
  if (flags === undefined) return { reason: '«IR.call»: операнд флагов не число — арность вызова неизвестна' };
  if (flags.argc > 2) return { reason: `«IR.call»: аргументов ${flags.argc}, носитель несёт не больше двух` };
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
function retForm(instruction: AsmInstruction): { form?: CarrierForm; reason?: string } {
  const flag = instruction.operands[0];
  if (flag === undefined || flag.kind !== 'imm') return { reason: '«IR.ret»: операнд «есть значение» не число' };
  const commands: CommandForm[] = flag.value === 1 ? [CALL_COMMAND_FORMS.get('movts')!] : [];
  commands.push(CALL_COMMAND_FORMS.get('return')!);
  return { form: { carrier: 'IR.ret', commands } };
}

/** Форма носителя или причина, почему её нет. Причина называется, а не подменяется догадкой. */
function carrierFormWithReason(
  instruction: AsmInstruction,
  context: CarrierFormContext,
): { form?: CarrierForm; reason?: string } {
  if (instruction.mnemonic === 'IR.call') return callForm(instruction);
  if (instruction.mnemonic === 'IR.ret') return retForm(instruction);
  if (instruction.mnemonic !== 'IR.invoke') {
    const form = carrierForm(instruction.mnemonic);
    return form === undefined ? {} : { form };
  }
  const names = context.invokeNames;
  if (names === undefined) {
    return {
      reason:
        '«IR.invoke»: не передан список имён хост-вызовов образа (`invokeNames`) — `payload` носителя ' +
        'это индекс в нём, и длину понижения (одна команда у «длина», девять у «добавить») взять негде',
    };
  }
  const payload = instruction.operands[3];
  const flags = instruction.operands[0];
  if (payload === undefined || payload.kind !== 'imm' || flags === undefined || flags.kind !== 'imm') {
    return { reason: '«IR.invoke»: операнды носителя не той формы (ожидались flags и payload числами)' };
  }
  const name = names[payload.value];
  if (name === undefined) {
    return {
      reason: `«IR.invoke»: в таблице имён нет записи с индексом ${payload.value} (всего имён ${names.length})`,
    };
  }
  const argc = flags.value >> 1;
  const hasDestination = (flags.value & 1) === 1;
  const destination = instruction.operands[4];
  const args = [instruction.operands[1], instruction.operands[2]].slice(0, argc) as readonly Operand[];
  const lowered = ((): readonly AsmInstruction[] | string => {
    try {
      return lowerArrayCall(name, args, hasDestination && destination?.kind === 'reg' ? destination.index : undefined);
    } catch (error) {
      return error instanceof Error ? error.message : String(error);
    }
  })();
  if (typeof lowered === 'string') return { reason: lowered };
  const commands: CommandForm[] = [];
  for (const command of lowered) {
    const form = ARRAY_COMMAND_FORMS.get(command.mnemonic);
    if (form === undefined) {
      return {
        reason:
          `«${name}»: у команды понижения «${command.mnemonic}» нет формы в таблице раскладки — ` +
          'длину взять негде (в рантайме массивов таких команд быть не должно)',
      };
    }
    commands.push(form);
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
  /** Команды в порядке выдачи. */
  readonly commands: readonly CommandForm[];
}

/** Инструкция, которой адрес не присвоен, и почему. */
export interface UnplacedInstruction {
  readonly index: number;
  readonly carrier: string;
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
  let offset = 0;
  instructions.forEach((instruction, index) => {
    const { form, reason } = carrierFormWithReason(instruction, context);
    if (form === undefined) {
      // Причина называется своя, если она известна (например, у `IR.invoke` без имён хост-вызовов):
      // общая отговорка «формы понижения нет» на этом месте врала бы — форма есть, её негде взять.
      unplaced.push({ index, carrier: instruction.mnemonic, reason: reason ?? unplacedReason(instruction.mnemonic) });
      return;
    }
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

/** Отказ второго прохода: переход, которому смещение не вычислено. */
export interface DisplacementRefusal {
  readonly index: number;
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
    const refuse = (reason: string): void => {
      refusals.push({ index, reason: `«${instruction.mnemonic}» #${index}: ${reason}` });
    };
    // Позиция цели в носителе: у `IR.jmp` она первая, у условного перехода — вторая (первая
    // занята регистром-условием: носитель несёт `(cond, off)`, src/e2k/emitterShell.ts).
    const targetAt = instruction.mnemonic === JUMP_CARRIER ? 0 : 1;
    const operand = instruction.operands[targetAt];
    if (operand === undefined || operand.kind !== "imm" || !Number.isInteger(operand.value)) {
      refuse(`цель перехода не выражена числом — операция несёт ${operand?.kind ?? "ничего"}`);
      return;
    }
    const targetIndex = operand.value;
    if (targetIndex < 0 || targetIndex >= instructions.length) {
      refuse(`цель перехода #${targetIndex} вне потока (инструкций ${instructions.length})`);
      return;
    }
    const commandAddress = addresses.get(index);
    if (commandAddress === undefined) {
      refuse(`команда не размещена — у «${instruction.mnemonic}» нет формы понижения`);
      return;
    }
    const targetAddress = addresses.get(targetIndex);
    if (targetAddress === undefined) {
      refuse(
        `цель перехода #${targetIndex} (${instructions[targetIndex]!.mnemonic}) не размещена — ` +
          `у неё нет формы понижения, адрес цели неизвестен`,
      );
      return;
    }
    const delta = targetAddress - commandAddress;
    if (delta % DISP_UNITS !== 0) {
      refuse(
        `разность адресов ${delta} не кратна ${DISP_UNITS}: смещение выражается только в ` +
          `восьмибайтовых словах (syllab-format.h:100)`,
      );
      return;
    }
    const disp = delta / DISP_UNITS;
    const problem = dispRangeProblem(disp);
    if (problem !== undefined) {
      refuse(problem);
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
