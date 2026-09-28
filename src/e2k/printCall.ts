/**
 * ПОДКЛЮЧЕНИЕ ПЕЧАТИ К КОНВЕЙЕРУ: САЙТ ВЫЗОВА `система.лог.вывести`.
 *
 * # Задача
 *
 * Развёртка «число → текст → `write`» живёт в `src/e2k/printPrimitives.ts` и измерена в модели
 * (`docs/hardware-debt.md` §3.40). Здесь — то, чего не хватало для КОРПУСА: носитель `IR.invoke`
 * с именем печати обязан получить
 *
 * 1. **байты** — ту же последовательность, что измерена (плюс сохранение живых регистров, см. ниже);
 * 2. **длину**, известную раскладке: без неё смещение перехода, пересекающего печать, считается по
 *    нулю и уводит поток (запись `43-печать-в-цикле` — оба её перехода пересекают печать);
 * 3. **число сохраняемых регистров**, которое несёт сам носитель ({@link PRINT_SAVE_COUNT_OPERAND}) —
 *    это единственный канал, которым длина сайта передаётся раскладке: она видит только носитель.
 *
 * # Почему нужно сохранение живых регистров, и почему именно `IR.spill_st`/`IR.spill_ld`
 *
 * Развёртка занимает `%b[0..11]` целиком ({@link PRINT_PRIMITIVE_CLOBBERS}): `%b[0]` — значение,
 * `%b[1..11]` — рабочие. Свободных регистров у языка **нет** (`%b[10..15]` держит рантайм массивов,
 * `src/e2k/arrayRuntime.ts`), поэтому «взять другие регистры под развёртку» нечем.
 *
 * Значит вызывающий обязан сохранить то, что ему нужно ПОСЛЕ печати, — как в любой ABI вокруг
 * вызова. Средство уже есть и измерено: носители вытеснения `IR.spill_st`/`IR.spill_ld`
 * (`src/vliw/spill.ts`), форма — 24 байта (`movtd` адреса слота + `std`/`ldd`), понижение —
 * в `src/e2k/e2kRealRun.ts`. Ни одной новой формы при этом не вводится, и `e2kRealRun.ts` не
 * трогается вовсе.
 *
 * Замер живых регистров на потоке ПОСЛЕ раскладки (`.tmp/osnova-print-stream-dump.ts`):
 *
 * | запись | живы через печать | что это |
 * |---|---|---|
 * | `39`–`42` | **пусто** | печать — последняя работа программы, сохранять нечего |
 * | `43` | `%b[0]`, `%b[2]` | накопитель цикла и постоянная 1 (живёт до `IR.add` после печати) |
 * | `44` | **пусто** | сумма посчитана ДО печати, после неё работы нет |
 *
 * # Площадка под сохранённое — верх вытеснительной области
 *
 * Сохранённое кладётся в слоты **верхней половины** области вытеснения: `spillBase + 8·(16+k)`,
 * `k` — по числу сохранённых. Нижняя половина (слоты 0…15) остаётся раскладке: её вытеснение
 * начинается с нулевого слота (`src/e2k/regAlloc.ts`, `allocateProgram`). Пересечение названо
 * отказом, а не замалчивается ({@link PrintCallRefusal}).
 *
 * Слоты разных сайтов **переиспользуются**: сохранённое живёт только от своей записи до своего
 * чтения, а сайты не вложены друг в друга (в языке нет ни рекурсии в этом конвейере, ни
 * одновременности). Поэтому хватает `16 + saveCount ≤ 28` слотов из тридцати двух.
 *
 * # Имя вызова — одно, и это канон
 *
 * `система.лог.вывести` — каноническое имя; алиасы (`система.вывести`, `система.окно.вывод`)
 * сводит **парсер** (`src/compiler/language-registry.ts:745-746`), в байткод уходит канон. Поэтому
 * здесь одно имя, а не список: печатать через алиас — то же самое, что через канон.
 *
 * # Чего этот модуль НЕ делает
 *
 * - **Не завершает программу.** `exit` — не часть сайта: запись `43` печатает В ЦИКЛЕ, и выход на
 *   каждом вызове оборвал бы её после первой строки. Выход ставит конвейер один раз в конце образа
 *   (`src/e2k/programImage.ts`), и это то же правило §3.39, только с другой стороны.
 * - **Не трогает `src/e2k/printRuntime.ts`** (старая конструкция, заморожена владельцем): путь
 *   печати — через `printPrimitives.ts`.
 * - **Не берёт размеры у кодировщика.** Таблица форм ({@link printCommandForm}) — объявление;
 *   совпадение с кодировщиком проверяет оракул `src/e2k/printPipeline.test.ts` (негативный контроль
 *   там же: подмена размера обязана его покраснить).
 */
import type { AsmInstruction, Operand } from './backend';
import { ARRAY_REGISTERS } from './arrayRuntime';
import { IMAGE_TAIL_OFFSET, MINIMAL_BASE, SPILL_AREA_BYTES, spillBaseOf } from './elfMinimal';
import { LOWERING_CODES } from './loweringRefusal';
import { IMM_SHORT_MAX, REAL_LONG_FORM_SIZE, REAL_SHORT_FORM_SIZE } from './e2k-real';
import {
  PRINT_PRIMITIVE_CLOBBERS,
  exitPrimitives,
  numberToTextLeanPrimitives,
  numberToTextPrimitives,
  writeTextPrimitives,
} from './printPrimitives';
import { SYS_EXIT, WINDOW_NUMBER_REGISTER } from './syscallRuntime';

/** Каноническое имя вызова печати (алиасы сводит парсер). */
export const PRINT_CALL = 'система.лог.вывести';

/**
 * Операнд печатающего носителя, которым конвейер передаёт раскладке число сохраняемых регистров.
 *
 * Операндов у `IR.invoke` четыре содержательных (`[flags, arg0, arg1, payload]`) и пятый —
 * приёмник (`operands[4]`), поэтому канал длины — шестой. Он `imm` и не читается ни живостью
 * (`defUseOf` читает `0…4`), ни сопоставлением предикатов — то есть раскладке он виден, а
 * исполнителю нет.
 */
export const PRINT_SAVE_COUNT_OPERAND = 5;

/** Первый слот верхней половины вытеснительной области: `16…31` — под сайты печати. */
export const PRINT_SAVE_SLOT_BASE = 16;

/** Адрес кучи по конвенции образа — тот же, что `HEAP_OFFSET` конвейера (`src/e2k/programImage.ts`). */
export const PRINT_HEAP_BY_CONVENTION = MINIMAL_BASE + IMAGE_TAIL_OFFSET;

/** Отказ подключения печати: причина называется, а не замалчивается. */
export class PrintCallRefusal extends Error {
  /**
   * Код контракта отказа понижения (`OSN-LOW-005`): у печати своя личность.
   *
   * Код несёт САМ отказ, а не выводится читателем из имени класса или текста: наблюдатель
   * (`src/scripts/e2kLoweringDiagnostics.ts`) читает поле `code` — то же правило, что у отказа
   * записью (`src/e2k/loweringRefusal.ts`).
   */
  readonly code = LOWERING_CODES.print;
  constructor(message: string) {
    super(message);
    this.name = 'PrintCallRefusal';
  }
}

/** Во что носитель понижения кладёт байты: `movtd` адреса слота + `std` / `ldd`. */
const reg = (index: number): Operand => ({ kind: 'reg', index });
const imm = (value: number): Operand => ({ kind: 'imm', value });
const window_ = (index: number): Operand => ({ kind: 'reg', index, file: 'window' });
const a = (mnemonic: string, operands: readonly Operand[], channel = 0): AsmInstruction => ({
  mnemonic,
  channel,
  operands,
});
const slotLiteral = (address: number): Operand => ({ kind: 'imm64', value: BigInt(address) } as unknown as Operand);

const movtd = (address: number, destination: number): AsmInstruction => ({
  mnemonic: 'movtd',
  channel: 0,
  operands: [slotLiteral(address), reg(destination)],
});

/** `std` разрешён только в каналах 2 и 5 (`opcodes/e2k-opc.h:969-984`). */
const std = (value: number, base: number, offset: number): AsmInstruction => ({
  mnemonic: 'std',
  channel: 2,
  operands: [reg(value), reg(base), reg(offset)],
});

const ldd = (base: number, offset: number, destination: number): AsmInstruction => ({
  mnemonic: 'ldd',
  channel: 0,
  operands: [reg(base), reg(offset), reg(destination)],
});

// ─────────────────────────────────────────────────────────────────────────────
// ЧТО НЕСЁТ НОСИТЕЛЬ
// ─────────────────────────────────────────────────────────────────────────────

/** Вызов печати ли это по имени (канон; алиасы сводит парсер). */
export function isPrintCallName(name: string | undefined): boolean {
  return name === PRINT_CALL;
}

/** Вызов печати ли это: имя берётся из таблицы хост-вызовов образа. */
export function isPrintCarrier(instruction: AsmInstruction, invokeNames: readonly string[]): boolean {
  if (instruction.mnemonic !== 'IR.invoke') return false;
  const payload = instruction.operands[3];
  if (payload === undefined || payload.kind !== 'imm') return false;
  return invokeNames[payload.value] === PRINT_CALL;
}

/** Регистр значения: у печатающего носителя он первый аргумент. */
export function printArgumentOf(instruction: AsmInstruction): number | undefined {
  const argument = instruction.operands[1];
  return argument !== undefined && argument.kind === 'reg' ? argument.index : undefined;
}

/** Число сохраняемых регистров, которое несёт носитель (`undefined` — не несёт). */
export function printSaveCountOf(instruction: AsmInstruction): number | undefined {
  const operand = instruction.operands[PRINT_SAVE_COUNT_OPERAND];
  if (operand === undefined || operand.kind !== 'imm' || !Number.isInteger(operand.value)) return undefined;
  return operand.value;
}

/** Носитель с проставленным числом сохраняемых регистров: раскладке длина, понижению — план. */
export function withPrintSaveCount(instruction: AsmInstruction, saveCount: number): AsmInstruction {
  const operands = [...instruction.operands];
  operands[PRINT_SAVE_COUNT_OPERAND] = imm(saveCount);
  return { ...instruction, operands };
}

// ─────────────────────────────────────────────────────────────────────────────
// БАЙТЫ САЙТА
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Команды печати БЕЗ выхода: число → текст в площадке + `write(1, текст, длина)`.
 *
 * Выхода здесь нет намеренно (см. шапку): его ставит конвейер один раз в конце образа.
 */
export function printCallInstructions(argument: number, heapAddress: number): AsmInstruction[] {
  return [
    ...numberToTextPrimitives(argument, heapAddress).instructions,
    ...writeTextPrimitives(heapAddress),
  ];
}

/** Один сохранённый регистр: где он лежит и какой адрес слота ему выдан. */
export interface SavedRegister {
  readonly register: number;
  readonly address: number;
}

/** План сайта печати: что сохранить, каким регистром адресовать слоты и число для раскладки. */
export interface PrintSitePlan {
  readonly argument: number;
  readonly heapAddress: number;
  readonly saved: readonly SavedRegister[];
  /** Регистр адреса слота: мёртв через печать, поэтому им и адресуют. */
  readonly scratch: number;
}

/**
 * Спланировать сайт печати: кого сохранить, каким регистром адресовать, куда положить.
 *
 * @param options.liveAfter регистры, живые ПОСЛЕ носителя (живость по графу потока управления)
 * @param options.occupied адреса слотов, уже занятые вытеснением раскладки
 */
export function planPrintSite(options: {
  readonly argument: number;
  readonly heapAddress: number;
  readonly liveAfter: readonly number[];
  readonly occupied?: readonly number[];
  /**
   * Какие регистры сайт портит. По умолчанию — вся развёртка (`%b[0..11]`); у РАЗДЕЛЁННОГО сайта
   * набор свой и МЕНЬШЕ ({@link SHARED_SITE_CLOBBERS}): там развёртка живёт в вызываемой, а у
   * вызывающего портятся только её окно и хвост `write`. Один планировщик на оба случая — чтобы
   * «кого сохранять» не разошлось с тем, «что портится».
   */
  readonly clobbered?: readonly number[];
}): PrintSitePlan {
  const { argument, heapAddress } = options;
  const clobbered = new Set<number>(options.clobbered ?? PRINT_PRIMITIVE_CLOBBERS);
  const saved = [...new Set(options.liveAfter)].filter((register) => clobbered.has(register)).sort((a, b) => a - b);
  // Регистр адреса слота обязан быть мёртв через печать (иначе `movtd` затрёт живое значение) и не
  // быть регистром значения (значение читается развёрткой ПОСЛЕ сохранения).
  const busy = new Set<number>([...saved, argument]);
  const scratch = (options.clobbered ?? PRINT_PRIMITIVE_CLOBBERS).find((register) => !busy.has(register));
  if (scratch === undefined) {
    throw new PrintCallRefusal(
      `«${PRINT_CALL}»: сохранить надо ${String(saved.length)} регистров (${saved.map((r) => `%b[${String(r)}]`).join(', ')}), ` +
        `а свободного регистра под адрес слота нет: развёртка занимает %b[0..11] целиком, ` +
        `%b[12..15] держит рантайм массивов. Нужно вытеснение живого значения до печати — это отдельная работа`,
    );
  }
  const saveAreaStart = spillBaseOf(heapAddress) + 8 * PRINT_SAVE_SLOT_BASE;
  const saveAreaEnd = spillBaseOf(heapAddress) + SPILL_AREA_BYTES;
  const occupied = [...new Set(options.occupied ?? [])];
  const conflicts = occupied.filter((address) => address >= saveAreaStart && address < saveAreaEnd);
  if (conflicts.length > 0) {
    throw new PrintCallRefusal(
      `«${PRINT_CALL}»: слоты печати (${saveAreaStart.toString(16)}…${(saveAreaEnd - 1).toString(16)}) заняты вытеснением ` +
        `раскладки (адреса ${conflicts.map((address) => address.toString(16)).join(', ')}) — писать поверх нельзя`,
    );
  }
  return {
    argument,
    heapAddress,
    scratch,
    saved: saved.map((register, index) => ({
      register,
      address: spillBaseOf(heapAddress) + 8 * (PRINT_SAVE_SLOT_BASE + index),
    })),
  };
}

/**
 * Команды сайта целиком: сохранение → печать → восстановление.
 *
 * Один источник байт и для раскладки (через {@link printCommandForm}), и для образа
 * (`src/e2k/programImage.ts`): разойтись им нечем.
 */
export function printSiteInstructions(plan: PrintSitePlan): AsmInstruction[] {
  const zero = ARRAY_REGISTERS.zero;
  const instructions: AsmInstruction[] = [];
  for (const item of plan.saved) {
    instructions.push(movtd(item.address, plan.scratch), std(item.register, plan.scratch, zero));
  }
  instructions.push(...printCallInstructions(plan.argument, plan.heapAddress));
  for (const item of plan.saved) {
    instructions.push(movtd(item.address, plan.scratch), ldd(plan.scratch, zero, item.register));
  }
  return instructions;
}

// ─────────────────────────────────────────────────────────────────────────────
// РАЗДЕЛЁННАЯ ПЕЧАТЬ: «ЧИСЛО → ТЕКСТ» В ЛИСТОВОЙ ПРОЦЕДУРЕ, `write` У ВЫЗЫВАЮЩЕГО
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Носитель ЛИСТОВОЙ процедуры «число → текст»: вход — свой `%r0`, выход — слова площадки.
 *
 * Зачем отдельный носитель, а не вызов обычной процедуры: тело процедуры — не носитель IR, а
 * ГОТОВЫЕ команды (развёртка), и раскладке нужна её длина. Носитель даёт и то, и другое: форму
 * (сумма форм команд развёртки) и понижение (сами команды, в оконной форме — процедура листовая).
 */
export const PRINT_TEXT_CARRIER = 'IR.print_text';

/** Носитель хвоста `write` у ВЫЗЫВАЮЩЕГО: читает слова площадки и делает системный вызов. */
export const PRINT_WRITE_CARRIER = 'IR.print_write';

/**
 * НОСИТЕЛЬ ВЫХОДА ПРОГРАММЫ: `exit(код)` или `exit(значение)`.
 *
 * Зачем отдельный носитель, а не «выход в конце образа»: выход — это КОМАНДЫ, и они занимают
 * байты. Пока он приписывался к образу мимо раскладки, адреса всего, что стояло за ним, уезжали —
 * и это вылезло ровно тогда, когда за точкой входа появилась процедура (разделённая печать):
 * вызов разделённой печати прыгал на 40 байт выше своего тела. Правило то же, что в §3.35:
 * раскладка обязана видеть каждый байт образа.
 *
 * Операнды: `[код, регистр?]` — с регистром выходим ЗНАЧЕНИЕМ (код возврата программы), без него —
 * кодом. Первый возврат точки входа становится выходом, остальные — нулевыми (`prepareImage`).
 */
export const EXIT_CARRIER = 'IR.exit';

/** Команды выхода: значением (если дан регистр) или кодом. */
export function exitCarrierInstructions(code: number, valueRegister?: number): AsmInstruction[] {
  if (valueRegister === undefined) return [...exitPrimitives(code)];
  const zero = ARRAY_REGISTERS.zero;
  return [
    // Значение уезжает в оконный `%r9` (аргумент выхода) через ноль рантайма: форма измерена на
    // выходе всех программ корпуса (`src/e2k/programImage.ts`), и она же стоит в `e2kProgramRun`.
    a('adds', [reg(valueRegister), reg(zero), window_(WINDOW_NUMBER_REGISTER + 1)]),
    a('movts', [imm(SYS_EXIT), window_(WINDOW_NUMBER_REGISTER)]),
    a('sdisp', [imm(1), imm(0)]),
    a('call', [imm(1), imm(4)]),
  ];
}

/** Имя скрытой процедуры: в модуле такой нет, её ставит конвейер (в отчётах видно по имени). */
export const SHARED_PRINT_PROCEDURE = '⟨печать числа⟩';

/**
 * РЕГИСТРЫ, КОТОРЫЕ РАЗДЕЛЁННЫЙ САЙТ ПОРТИТ У ВЫЗЫВАЮЩЕГО.
 *
 * Их два источника, и оба названы замером:
 *
 * | источник | регистры | почему |
 * |---|---|---|
 * | вызываемая | `%r8..%r15` вызывающего | её окно — это они: `call wbs = 4` сдвигает окно на восемь регистров |
 * | хвост `write` | `%b[2]`, `%b[4]`, `%b[6]`, `%b[9]` | хвост читает слова площадки и кладёт аргументы вызова (`r.value`, `r.scratch`, `r.offset`, `r.zero`) |
 *
 * Из раскладываемых (`%b[0..9]`) отсюда выходят `%b[2]`, `%b[4]`, `%b[6]`, `%b[8]`, `%b[9]` —
 * их и надо сохранить, если через сайт они живы. Регистры `%b[10..15]` не трогаются вовсе: они
 * зарезервированы рантаймом массивов. Это МЕНЬШЕ, чем у инлайновой печати (та занимает `%b[0..11]`
 * целиком), и это ещё одна плата, которую разделение снимает.
 */
export const SHARED_SITE_CLOBBERS: readonly number[] = [2, 4, 6, 8, 9];

/** Команды листовой процедуры «число → текст» (вход — свой `%r0`). */
export function printTextInstructions(heapAddress: number): AsmInstruction[] {
  return [...numberToTextLeanPrimitives(heapAddress).instructions];
}

/** Команды хвоста `write` у вызывающего (слова площадки → системный вызов). */
export function printWriteInstructions(heapAddress: number): AsmInstruction[] {
  return [...writeTextPrimitives(heapAddress)];
}

/** Формы команд носителя печати — тем же объявлением, что у развёртки (проверяет оракул). */
export function printCarrierForms(instructions: readonly AsmInstruction[]): PrintCommandForm[] | string {
  const forms: PrintCommandForm[] = [];
  for (const instruction of instructions) {
    const form = printCommandForm(instruction);
    if (form === undefined) {
      return `у команды «${instruction.mnemonic}» нет формы в таблице — длину взять негде (src/e2k/printCall.ts:printCommandForm)`;
    }
    forms.push(form);
  }
  return forms;
}

/** Форма команды развёртки: размер объявлен здесь, совпадение с кодировщиком проверяет оракул. */
export interface PrintCommandForm {
  readonly mnemonic: string;
  readonly form: string;
  readonly size: number;
  readonly source: string;
}

/**
 * Источник размеров — замер, а не догадка.
 *
 * Все **150** команд развёртки сверены с `as-new -mcpu=elbrus-v5` побайтово
 * (`docs/hardware-debt.md` §3.40.5), поэтому размер каждой команды здесь — копия измеренного.
 * Второй свидетель — наш кодировщик: оракул `src/e2k/printPipeline.test.ts` сверяет с ним
 * каждый размер, и расхождение краснеет.
 */
const FORM_SOURCE =
  'замер: 150 команд развёртки печати совпали с `as-new -mcpu=elbrus-v5` побайтово ' +
  '(docs/hardware-debt.md §3.40.5); форма слога — src/e2k/e2k-real.ts, opcodes/e2k-opc.h';

const LONG_FORM_SOURCE =
  `${FORM_SOURCE}; длинная форма ALS + ALES — REAL_LONG_FORM_SIZE (16 байт), ` +
  'короткая — REAL_SHORT_FORM_SIZE (8 байт)';

/** Размер команды по её операндам: непосредственное 0…15 кодируется короткой формой. */
function immediateSize(instruction: AsmInstruction): number {
  const literals = instruction.operands.filter(
    (operand): operand is { kind: 'imm'; value: number } => operand.kind === 'imm',
  );
  const long = literals.some((operand) => !Number.isInteger(operand.value) || operand.value < 0 || operand.value > IMM_SHORT_MAX);
  return long ? REAL_LONG_FORM_SIZE : REAL_SHORT_FORM_SIZE;
}

/**
 * Форма команды развёртки печати; `undefined` — мнемоники нет в таблице (длину взять негде).
 *
 * Размеры: `subs`, `sdivs`, `stb`, `std`, `ldd`, `setbn`, `sdisp`, `movts` (регистр→регистр) —
 * короткая форма, 8 байт; `movtd`, `muls`, `call` — 16; `shrs` с непосредственным сдвигом — 16
 * (литеральное слово команды); `movts`/`adds` с непосредственным — 8, если значение 0…15, иначе 16.
 */
export function printCommandForm(instruction: AsmInstruction): PrintCommandForm | undefined {
  const short = (form: string): PrintCommandForm => ({
    mnemonic: instruction.mnemonic,
    form,
    size: REAL_SHORT_FORM_SIZE,
    source: FORM_SOURCE,
  });
  const long = (form: string): PrintCommandForm => ({
    mnemonic: instruction.mnemonic,
    form,
    size: REAL_LONG_FORM_SIZE,
    source: LONG_FORM_SOURCE,
  });
  switch (instruction.mnemonic) {
    case 'subs':
    case 'sdivs':
      return short('ALF1');
    case 'stb':
      return short('ALF3');
    case 'std':
    case 'ldd':
    case 'ldb':
      // `ldb` — та же форма загрузки, что `ldd`, но байтом: `opcodes/e2k-opc.h:604` (ALF1, ARGS_DDD).
      // Нужна строковому рантайму: проход по байтам за длиной в кодпоинтах и копирование при склейке
      // (`src/e2k/stringRuntime.ts`).
      return short('ALF3 (ldd/ldb — ALF1)');
    case 'setbn':
      return short('ALF2');
    case 'sdisp':
      return short('CS0 (C0F2)');
    case 'movtd':
      return long('ALF2 + LTS');
    case 'muls':
      return long('ALF11');
    case 'call':
      return long('CS1 (SS + C1F1)');
    case 'movts':
      return immediateSize(instruction) === REAL_SHORT_FORM_SIZE ? short('ALF2') : long('ALF2 + LTS');
    case 'adds':
      return immediateSize(instruction) === REAL_SHORT_FORM_SIZE ? short('ALF1') : long('ALF11');
    case 'shrs':
      // Сдвиг с непосредственным несёт литеральное слово: замер — `shrs %b[4], 31, %b[4]` = 16 байт.
      return long('ALF11');
    default:
      return undefined;
  }
}

/**
 * Байт на сохранённый регистр: сохранение (`movtd` + `std`) и восстановление (`movtd` + `ldd`).
 *
 * Не «48 по памяти», а сумма форм: оракул сверяет её с байтами, которые выдаёт
 * {@link printSiteInstructions}, и с кодировщиком.
 */
export const PRINT_SAVE_BYTES_PER_REGISTER =
  REAL_LONG_FORM_SIZE +
  REAL_SHORT_FORM_SIZE +
  REAL_LONG_FORM_SIZE +
  REAL_SHORT_FORM_SIZE;

/** Источник для размера сохранения — тот же замер, что у форм команд. */
export const PRINT_SAVE_SOURCE =
  `${FORM_SOURCE}; сохранение — movtd (16) + std (8), восстановление — movtd (16) + ldd (8)`;
