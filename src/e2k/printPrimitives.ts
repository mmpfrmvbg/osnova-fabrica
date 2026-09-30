/**
 * ПРИМИТИВЫ ПЕЧАТИ e2k: ЧИСЛО → ДЕСЯТИЧНЫЙ ТЕКСТ В ПАМЯТИ, ПРЯМОЙ ПОСЛЕДОВАТЕЛЬНОСТЬЮ.
 *
 * # Зачем отдельный модуль
 *
 * Печать держит **15 записей корпуса из 20** нецелевых: язык умеет считать, но не умеет отдать
 * результат наружу иначе как 8-битным кодом возврата (`docs/hardware-debt.md` §3.31). Кирпичи
 * измерены по отдельности (`write` — `buildHelloProgram`, `sdivs`, `muls`, `adds` с литералом,
 * `stb`/`ldd`/`std`), а **последовательности «число → текст» не было ни в одном рабочем виде**.
 * Здесь она собрана целиком и доведена до записи в память.
 *
 * # Чем это отличается от `printRuntime.ts` (заморожен владельцем, читать можно, править нельзя)
 *
 * | решение | `printRuntime.ts` | здесь | почему |
 * |---|---|---|---|
 * | разряд в буфере | слово (`std`), 8 байт на разряд | **байт** (`stb`), 1 байт на разряд | критерий приёмки — байты `39 37 38` **подряд**; слово дало бы `39 00 …`, и `write` отдал бы нули между цифрами — «10» из такой области не получается ни при какой длине (§3.42.2, часть В). `stb` измерен: `.tmp/osnova-print-primitives.ts` |
 * | знак | `shrs(v,31)` считается за −1 | `shrs(v,31)` — **логический** сдвиг, даёт 1 | измерено по источнику порта: `gen_shr_i32` = `tcg_gen_shr_i32` (`qemu/target/e2k/tcg/translate-al-c2.c:265-271`), то есть бит 31 встаёт в бит 0. С −1 модуль выходил бы `muls(v, 1+2·1) = 3v` |
 * | счёт разрядов | девять порогов по 5 команд | три команды на разряд, порог 10 | `[v ≥ 10] = shrs(9 − v, 31)` — знак разности без сравнения и без ветвления |
 * | перевод строки | не входит в длину | входит: `\n` сразу за младшим разрядом | эталоны записей `39`–`44` кончаются `0a` (§3.42.1): у `43` три вызова дают три строки |
 * | длина и адрес | считает хвост по слоту знака | считает сама последовательность, кладёт **в память** | граница «число → текст» отделена от «отдать наружу»: хвост `write` читает два слова и не знает про регистры разрядов |
 * | завершение | нет (и печатающая программа падает — §3.39) | {@link printNumberPrimitives} делает своё `exit(0)` | программа без возврата значения на цели падает (134), а не выходит нулём |
 *
 * # Почему без циклов, без сравнений и без ветвлений
 *
 * Цикл в этой плоскости упирается в сопоставление предикатов: результат сравнения читают и переход,
 * и арифметика, а предикат у пары «сравнение + переход» один (`src/e2k/predicatePairing.ts`).
 * Поэтому разряды берутся **развёрткой**: десять шагов подряд, каждый — свои команды. Переходов в
 * последовательности нет вовсе (`ct`/`disp` не выдаются ни одной), значит раскладке внутри неё
 * считать нечего.
 *
 * # Площадка: где живёт текст
 *
 * | что | где | зачем |
 * |---|---|---|
 * | разряды | `digitsBase + (9 − i)`, `i` — от младшего | старший разряд — по младшему адресу, как в тексте |
 * | знак | `digitsBase − 1` (при десяти разрядах и минусе) | байт левее первого разряда; у неотрицательного он вне отрезка `write` и безвреден |
 * | адрес текста | слово `startWord` площадки | граница с хвостом `write` |
 * | длина текста | слово `lengthWord` площадки | там же |
 *
 * # Что измерено прогоном в модели (паспортная сборка, `-d strace` + шим)
 *
 * | опыт | результат |
 * |---|---|
 * | `stb` пишет БАЙТ: два байта подряд (`39` по X, `37` по X+1), чтение обратно | память `39 37 00 …`; `ldb` → **0x39**, `ldd` → **0x3739** — словесная запись затёрла бы первый байт |
 * | печать числа | `10` → `31 30 0a`, `0` → `30 0a`, `-7` → `2d 37 0a`, `978` → `39 37 38 0a`, `100` → `31 30 30 0a` — байты равны эталонам записей `39`–`44` ЦЕЛИКОМ, код возврата **0** |
 * | адрес и длина в журнале `write(1,<адрес>,<длина>)` | совпали с расчётом ПО ЧИСЛУ в TS (независимый свидетель) во всех восьми опытах |
 * | площадка `0x101EC0` | запись и `write` проходят: страница кода в этой точке **не** защищена (прежний ACCERR был на странице ЗАГОЛОВКОВ, `MINIMAL_BASE + 0x88`) |
 * | `%b[8]` и оконный `%r8` | **одна ячейка**: после `movts 4 → %r8` чтение `%b[8]` даёт `04`. Отсюда порядок хвоста: аргументы `write` кладутся последними |
 * | сверка с `as-new -mcpu=elbrus-v5` | **150 команд из 150 совпали побайтово**; поток до первого `call` (140 команд, 1432 байта) совпал целиком; дальше `as` вставляет нулевые слоты (`nop`) — 32 байта перед выходом и 16 в конце, поэтому его образ длиннее на 48 |
 * | дизассемблер МЦСТ читает НАШ образ | 150 команд по адресам; адреса дизассемблера на `0x1000` ниже наших — он берёт адрес секции `.text`, а `buildElfFromCode` кладёт код по `base + 0x1000` (несогласованность заголовков ELF, не наша и не чинится здесь) |
 * | две печати ПОДРЯД | `31 0a 32 0a`, два `write` в журнале, код 0 — буфер переиспользуется между вызовами |
 *
 * # Границы, названные ЧИСЛОМ
 *
 * - **Площадка лежит в ОБЛАСТИ ЗАПИСИ — на своей странице** (`spillBase − 64` = `0x110EC0` при
 *   конвенции образа, страница `0x110000`). Раньше она стояла сразу за кодом (`0x101EC0`), и запись
 *   разрядов падала `ACCERR`, как только код заходил в ту же страницу: **три печати ПОДРЯД** пишут
 *   поверх себя и кончаются отказом (код 139) после двух строк — измерено. Сторож конвейера берёт не
 *   *адрес*, а *страницу* места записи (`src/e2k/programImage.ts#WRITE_PAGE_BYTES`): пока код ниже
 *   `0x110000`, печатать можно, а выше — названный отказ, а не падение (§3.90.7, §3.91).
 * - **Только целое 32-битное знаковое**, кроме `−2^31`: модуль берётся умножением на −1
 *   (`muls`), а `−(−2^31)` в 32 битах переполняется.
 * - **Печатается ровно `PRINT_DIGITS` шагов**: числа ≥ 10^10 не наблюдаются — то же соглашение,
 *   что у `sdivs` (32/32→32).
 * - **Регистры `%b[0..11]` портятся** ({@link PRINT_PRIMITIVE_REGISTERS}); `%b[12..15]` — состояние
 *   рантайма массивов, оно не трогается.
 * - **Своё `exit` печатающая программа обязана сделать сама** (§3.39): {@link numberToTextPrimitives}
 *   и {@link writeTextPrimitives} выхода НЕ делают (это половины), а {@link printNumberPrimitives}
 *   завершает последовательность выходом. Так замороженному `printRuntime.ts` для подключения нужна
 *   ровно одна новая часть — своя пара `exit` после `writeTail` (текст правки — §3.42.2, часть А).
 */

import { getEncoder, type AsmInstruction, type Operand } from './backend';
import { IMAGE_TAIL_OFFSET, MINIMAL_BASE, spillBaseOf } from './elfMinimal';
import { ARRAY_WINDOW_RSZ } from './arrayRuntime';
import {
  ENTRY_SYSCALL_FRAME,
  SYS_EXIT,
  SYS_WRITE,
  STDOUT_FD,
  syscallWindowOf,
  type SyscallFrame,
} from './syscallRuntime';

/** Десятичное основание. */
export const PRINT_BASE = 10;

/** Код ASCII нуля: код разряда — `48 + разряд`. */
export const ASCII_ZERO = 48;

/** Код ASCII минуса — байт знака. */
export const ASCII_MINUS = 45;

/**
 * ПЕРЕВОД СТРОКИ — ЧАСТЬ ЭТАЛОНА, А НЕ ОФОРМЛЕНИЕ.
 *
 * Байты шести печатающих записей корпуса (`docs/hardware-debt.md` §3.42.1): `39` = `31 30 0a`,
 * `40` = `30 0a`, `41` = `2d 37 0a`, `42` = `39 37 38 0a`, `43` = `31 0a 32 0a 33 0a`,
 * `44` = `31 30 30 0a`. У `43` три вызова печати дают три строки — значит `\n` добавляет **каждый**
 * вызов, а не программа. Без него запись `43` дала бы «123» вместо «1\n2\n3\n».
 */
export const ASCII_NEWLINE = 0x0a;

/** Разрядов в развёртке: `2^31 < 10^10`, десяти хватает на любое 32-битное. */
export const PRINT_DIGITS = 10;

/**
 * РАБОЧИЕ РЕГИСТРЫ ПОСЛЕДОВАТЕЛЬНОСТИ — `%b[0..11]`.
 *
 * `%b[12..15]` — состояние рантайма массивов (`zero`, `one`, `eight`, `heap`): оно живёт через всю
 * программу, и последовательность его не трогает. `%b[10]`/`%b[11]` — **временные** рантайма
 * массивов (`scratch2`/`scratch`), они и заняты постоянными 1 и 9.
 *
 * `%b[8..11]` — те же физические ячейки, что оконные `%r8..%r11` при начальном `WD.base_d = 0`,
 * `rbs = rcur = 0` (`qemu/target/e2k/reg-index.h:19-59`: `%b[N]` → `(base + rbs + N % rsz_full)`,
 * `%rN` → `(base + N)`). Отсюда порядок хвоста: аргументы `write` кладутся **после** того, как
 * разряды уже в памяти, и затирание `%b[8..11]` ничего не портит.
 */
export const PRINT_PRIMITIVE_REGISTERS = {
  /** Значение (копия аргумента). */
  input: 0,
  /** Признак знака: 1 — отрицательное, 0 — нет (`shrs(вход, 31)`, сдвиг логический). */
  negative: 1,
  /** Модуль значения, затем частные. */
  value: 2,
  /** Частное `value / 10`. */
  quotient: 3,
  /** Временный: произведение, разряд, признак порога, адрес знака. */
  scratch: 4,
  /** Постоянная 10. */
  ten: 5,
  /** Смещение адресации (`stb`/`ldd`/`std` обязаны брать основание и смещение из РАЗНЫХ регистров). */
  offset: 6,
  /** Адрес площадки — основание адресации. */
  buffer: 7,
  /** Счёт разрядов. */
  count: 8,
  /** Постоянный ноль: нулевое смещение и «нет минуса». */
  zero: 9,
  /** Постоянная 1: `1 − 2·знак` даёт −1 у отрицательного и 1 у неотрицательного. */
  one: 10,
  /** Постоянная 9: `9 − value` — проверка `value ≥ 10` знаком разности. */
  nine: 11,
} as const;

/** Регистры, которые последовательность портит: их не имеет права держать чужое значение. */
export const PRINT_PRIMITIVE_CLOBBERS: readonly number[] = Object.values(PRINT_PRIMITIVE_REGISTERS);

/**
 * РАЗМЕТКА ПЛОЩАДКИ в байтах.
 *
 * `sign` — запасной байт под минус: у отрицательного десятиразрядного числа `-` стоит на
 * `digitsBase − 1`, то есть **ниже** разрядов.
 */
export const PRINT_AREA_LAYOUT = {
  /** Байт знака при десяти разрядах и минусе (иначе не используется). */
  sign: 1,
  /** Первый (старший) слот разряда: разряды занимают `digits … digits + PRINT_DIGITS − 1`. */
  digits: 2,
  /**
   * Перевод строки — **всегда сразу за младшим разрядом**: разряды кончаются на
   * `digits + PRINT_DIGITS − 1` при любом их числе, поэтому байт `\n` стоит по постоянному адресу.
   */
  newline: 2 + 10,
  /** Слово «адрес первого байта текста» (8 байт). */
  startWord: 16,
  /** Слово «длина текста в байтах» (8 байт). */
  lengthWord: 24,
} as const;

/** Размер площадки целиком. */
export const PRINT_AREA_BYTES = 32;

/**
 * ОТСТУП ПЛОЩАДКИ ОТ ОБЛАСТИ ВЫТЕСНЕНИЯ: площадка лежит **под** ней, в хвосте образа.
 *
 * Почему не в куче и не в её первой странице: куча растёт вверх от `MINIMAL_BASE + 0x2000`, и
 * первый же блок массива затёр бы площадку по нулевому смещению. Печать **не должна выделять
 * память** (пример `43` печатает в цикле), поэтому место берётся статически.
 *
 * 64 байта, а не 32, — соглашение карты (`MINIMAL_BASE + 0x2000 − 0x100 − 64`); площадка занимает
 * младшие 32 из них.
 */
export const PRINT_AREA_TAIL_OFFSET = 64;

/**
 * Адрес площадки при данном адресе кучи: `spillBaseOf(куча) − 64`.
 *
 * При конвенции образа (`MINIMAL_BASE + IMAGE_TAIL_OFFSET` = `0x111000`) это `0x110EC0` — **своя
 * страница**, где нет кода. Прежняя редакция стояла на `0x101EC0`, то есть на первой странице после
 * кода: запись разрядов проходила, пока код не заходил в эту страницу, и падала `ACCERR`, как только
 * заходил (замер 2026-09-29: конец кода `0x101480` — исключение на `0x101ecb`, `0x1008d0` — код 0;
 * `docs/hardware-debt.md` §3.90.7, §3.91).
 */
export function printAreaOf(heapAddress: number): number {
  return spillBaseOf(heapAddress) - PRINT_AREA_TAIL_OFFSET;
}

/** Адрес площадки по конвенции образа. */
export const DEFAULT_PRINT_AREA = printAreaOf(MINIMAL_BASE + IMAGE_TAIL_OFFSET);

/** Отказ примитивов печати: причина называется, а не замалчивается. */
export class PrintPrimitiveRefusal extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PrintPrimitiveRefusal';
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// ФОРМЫ КОМАНД (каждая — измеренная; источники в шапке и в таблице МЦСТ)
// ─────────────────────────────────────────────────────────────────────────────

const reg = (index: number): Operand => ({ kind: 'reg', index });
const imm = (value: number): Operand => ({ kind: 'imm', value });
const window_ = (index: number): Operand => ({ kind: 'reg', index, file: 'window' });
const f64 = (value: number): Operand => ({ kind: 'imm64', value: BigInt(value) } as unknown as Operand);

const a = (mnemonic: string, operands: readonly Operand[], channel = 0): AsmInstruction => ({ mnemonic, channel, operands });

/** Короткая пересылка: литерал 0…15 кодируется короткой непосредственной формой (`0xc0 | N`). */
const movts = (value: number, destination: number): AsmInstruction => a('movts', [imm(value), reg(destination)]);

/** Пересылка регистр→регистр: отдельной мнемоники у МЦСТ нет, вид операнда решает (`e2k-opc.h:644`). */
const movtsReg = (source: number, destination: number): AsmInstruction => a('movts', [reg(source), reg(destination)]);

/** 64-битный литерал (`_f64`, форма 0xdc): адрес площадки в 16 бит не влезает. */
const movtd = (value: number, destination: number): AsmInstruction => a('movtd', [f64(value), reg(destination)]);

/** Запись байта: `stb значение, база, смещение` — порядок операндов измерен (`.tmp/std-order.ts`). */
const stb = (value: number, base: number, offset: number): AsmInstruction => a('stb', [reg(value), reg(base), reg(offset)], 2);

/** Запись слова: рабочая граница с хвостом `write`. */
const std = (value: number, base: number, offset: number): AsmInstruction => a('std', [reg(value), reg(base), reg(offset)], 2);

/** Чтение слова. */
const ldd = (base: number, offset: number, destination: number): AsmInstruction => a('ldd', [reg(base), reg(offset), reg(destination)]);

/** Целочисленное деление: канал ТОЛЬКО пятый (`e2k-opc.h:69`, измерено `.tmp/idiv-channel.ts`). */
const sdivs = (left: number, right: number, destination: number): AsmInstruction => a('sdivs', [reg(left), reg(right), reg(destination)], 5);

const muls = (left: number, right: number, destination: number): AsmInstruction => a('muls', [reg(left), reg(right), reg(destination)]);
const adds = (left: number, right: number, destination: number): AsmInstruction => a('adds', [reg(left), reg(right), reg(destination)]);
const addsImm = (source: number, value: number, destination: number): AsmInstruction => a('adds', [reg(source), imm(value), reg(destination)]);
const subs = (left: number, right: number, destination: number): AsmInstruction => a('subs', [reg(left), reg(right), reg(destination)]);
const shrs = (source: number, shift: number, destination: number): AsmInstruction => a('shrs', [reg(source), imm(shift), reg(destination)]);

/** Окно вращаемых регистров: без него системный вызов не принимается. */
const setbn = (rsz: number): AsmInstruction => a('setbn', [imm(rsz), imm(0), imm(0)]);

// ─────────────────────────────────────────────────────────────────────────────
// ПОСЛЕДОВАТЕЛЬНОСТЬ «ЧИСЛО → ТЕКСТ»
// ─────────────────────────────────────────────────────────────────────────────

/** Что последовательность оставляет после себя. */
export interface NumberToText {
  /** Команды: разряды в буфере и два слова-границы. */
  readonly instructions: readonly AsmInstruction[];
  /** Адрес площадки. */
  readonly area: number;
  /** Адрес старшего слота разряда (`area + PRINT_AREA_LAYOUT.digits`). */
  readonly digitsBase: number;
  /** Адрес байта знака при десяти разрядах и минусе. */
  readonly signByte: number;
  /** Адрес слова «адрес текста». */
  readonly startWord: number;
  /** Адрес слова «длина текста». */
  readonly lengthWord: number;
}

/**
 * СОБРАТЬ ПОСЛЕДОВАТЕЛЬНОСТЬ: значение из регистра `argument` → десятичный текст в площадке.
 *
 * Последовательность — **прямая**: ни одного перехода, ни одного сравнения, десять шагов разбора и
 * прямой счёт длины. Что она делает по шагам:
 *
 * | шаг | команды | что получается |
 * |---|---|---|
 * | знак | `shrs` → `adds` → `subs` → `muls` | `%b[1]` — 1 или 0; `%b[2]` — модуль значения (`muls(v, 1 − 2·знак)`) |
 * | константы | `movts`×4, `movtd` | 10, 0, 1, 9 и адрес площадки — в регистрах, а не в операндах |
 * | разряд `i` | `sdivs` → `muls` → `subs` → `adds 48` → `movts` → `stb` | код разряда — байтом в свой слот |
 * | счёт | `subs 9−v` → `shrs` → `adds` | `[v ≥ 10]` знаком разности: счёт начинается с единицы (ноль — один разряд) |
 * | адрес и длина | `movts`/`subs`/`adds` | адрес = `digitsBase + (10 − разряды) − знак`, длина = `разряды + знак` |
 * | знак байтом | `subs` → `movts 45` → `stb` | минус ложится на байт левее текста; у неотрицательного — вне `write` |
 * | граница | `movtd` → `std` ×2 | адрес и длина — в слова площадки: хвост читает их, а не регистры |
 *
 * @param argument регистр со значением (его выдала раскладка или проба)
 * @param heapAddress адрес кучи образа — от него считается площадка
 */
export function numberToTextPrimitives(argument: number, heapAddress: number): NumberToText {
  const r = PRINT_PRIMITIVE_REGISTERS;
  const area = printAreaOf(heapAddress);
  const digitsBase = area + PRINT_AREA_LAYOUT.digits;
  const startWord = area + PRINT_AREA_LAYOUT.startWord;
  const lengthWord = area + PRINT_AREA_LAYOUT.lengthWord;
  const instructions: AsmInstruction[] = [];

  // 1. Значение — в рабочий регистр.
  if (argument !== r.input) instructions.push(movtsReg(argument, r.input));

  // 2. КОНСТАНТЫ — ПЕРВЫМИ. Порядок не косметика: модуль знака считает `1 − 2·знак`, то есть
  //    читает постоянную единицу, и если материализовать её после, произведение даст ноль
  //    (измерено `.tmp/osnova-print-area-dump.ts`: разряды выходили `30 30 …` при любом входе).
  instructions.push(
    movts(PRINT_BASE, r.ten),
    movts(0, r.zero),
    movts(1, r.one),
    movts(9, r.nine),
    movtd(area, r.buffer),
    movts(1, r.count), // счёт начинается с единицы: ноль — это один разряд
  );

  // 3. Знак и модуль: `shrs` логический, поэтому признак — 1/0, а не −1/0.
  instructions.push(
    shrs(r.input, 31, r.negative), // 1 у отрицательного, 0 у неотрицательного
    adds(r.negative, r.negative, r.scratch), // 2·знак
    subs(r.one, r.scratch, r.scratch), // 1 − 2·знак: −1 у отрицательного, 1 у неотрицательного
    muls(r.input, r.scratch, r.value), // модуль
  );

  // 4. Десять разрядов: прямые шаги, без цикла и без сравнений. Разряд `i` (от младшего) — в слот
  //    `digits + PRINT_DIGITS − 1 − i` площадки: старший разряд по младшему адресу, как в тексте.
  for (let index = 0; index < PRINT_DIGITS; index++) {
    instructions.push(
      sdivs(r.value, r.ten, r.quotient), // q = v / 10
      muls(r.quotient, r.ten, r.scratch), // q·10
      subs(r.value, r.scratch, r.scratch), // разряд = v − q·10 (остатка у IR формы нет)
      addsImm(r.scratch, ASCII_ZERO, r.scratch), // код разряда
      movts(PRINT_AREA_LAYOUT.digits + PRINT_DIGITS - 1 - index, r.offset),
      stb(r.scratch, r.buffer, r.offset), // байтом — в свой слот (основание ≠ смещение)
      subs(r.nine, r.value, r.scratch), // 9 − v
      shrs(r.scratch, 31, r.scratch), // 1, если v ≥ 10 (знак разности, а не сравнение)
      adds(r.count, r.scratch, r.count), // в счёт разрядов
      movtsReg(r.quotient, r.value), // v ← q
    );
  }

  // 5. Адрес первого байта текста и его длина — прямой арифметикой, без единого перехода.
  //    Счёт разрядов (`%b[8]`) здесь НЕ переиспользуется под константу: из него берётся длина.
  instructions.push(
    movts(PRINT_AREA_LAYOUT.digits + PRINT_DIGITS, r.scratch), // 2 + 10: смещение считается от начала площадки
    subs(r.scratch, r.count, r.scratch), // 10 − разряды: сколько слотов пропустить
    subs(r.scratch, r.negative, r.scratch), // минус сдвигает текст на байт влево
    adds(r.buffer, r.scratch, r.quotient), // адрес текста → %b[3]
    subs(r.quotient, r.one, r.scratch), // адрес последнего байта перед текстом
    adds(r.scratch, r.negative, r.scratch), // + знак: у отрицательного минус ВХОДИТ в текст, у прочих лежит до него
    movts(ASCII_MINUS, r.value), // код минуса (значение больше не нужно)
    stb(r.value, r.scratch, r.zero), // минус — байтом; у неотрицательного он вне текста
    adds(r.count, r.negative, r.count), // длина = разряды + знак
    // Перевод строки: он часть эталона (`31 30 0a`), поэтому входит и в текст, и в длину.
    adds(r.count, r.one, r.count), // длина = разряды + знак + 1
    movts(ASCII_NEWLINE, r.value), // 0x0a
    movts(PRINT_AREA_LAYOUT.newline, r.offset), // сразу за младшим разрядом — адрес постоянный
    stb(r.value, r.buffer, r.offset),
  );
  // Разряды потеряны как число, но их счёт жив: он в `%b[8]`, а длина — уже в `%b[8]`. Адрес текста
  // и длина уезжают в память: граница «число → текст» должна быть видна снаружи, а не в регистрах.
  instructions.push(
    movtd(startWord, r.offset),
    std(r.quotient, r.offset, r.zero),
    movtd(lengthWord, r.offset),
    std(r.count, r.offset, r.zero),
  );

  return { instructions, area, digitsBase, signByte: digitsBase - 1, startWord, lengthWord };
}

// ─────────────────────────────────────────────────────────────────────────────
// ЛИСТОВАЯ (ВОСЬМИРЕГИСТРОВАЯ) ПОСЛЕДОВАТЕЛЬНОСТЬ: ТО ЖЕ ЧИСЛО → ТЕКСТ, НО В ОКНЕ ВЫЗЫВАЕМОЙ
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Регистры ЛИСТОВОЙ последовательности — ровно `%b[0..7]`, окно вызываемой.
 *
 * Вызываемая получает восемь регистров (`call wbs = 4` уменьшает `size_q`; измерено
 * `src/e2k/e2kCallWindowQemu.test.ts`), поэтому печать целиком в процедуру не выносится: системный
 * вызов из неё невозможен — номер идёт в `%r8`, которого у неё нет. А вот «число → текст» —
 * операция БЕЗ системного вызова, и её можно вынести в листовую процедуру: тогда развёртка (≈1400
 * байт) стоит в образе ОДИН раз, а каждый сайт печати платит за вызов и за `write` у вызывающего.
 *
 * Восемь регистров — тесно, и вот чем платим за двоих недостающих:
 *
 * | было (12 регистров) | стало | чем платим |
 * |---|---|---|
 * | `%b[8]` — счёт разрядов | `%b[0]` после модуля | вход мёртв после `muls` — его регистр и берёт счёт |
 * | `%b[9]` — постоянный ноль | `%b[2]` после разбора | значение обнуляется: `movts 0` (+8 байт) |
 * | `%b[10]` — постоянная 1 | `%b[6]` дважды по ходу | `movts 1` перед `1 − 2·знак` и перед адресом байта (−1) |
 * | `%b[11]` — постоянная 9 | `%b[4]` в каждом разряде | `movts 9` на разряд: +10 команд (+80 байт) |
 *
 * Итог: на **11 команд длиннее** полной последовательности (те же формы, те же слоты), но влезает
 * в окно вызываемой — а это и есть то, ради чего она существует.
 */
export const LEAN_PRINT_REGISTERS = {
  /** Значение, затем **счёт разрядов**: вход мёртв после взятия модуля. */
  input: 0,
  /** Признак знака: 1 — отрицательное, 0 — нет. */
  negative: 1,
  /** Модуль, затем частные; после разбора — **постоянный ноль** (нулевое смещение адресации). */
  value: 2,
  /** Частное, затем **адрес первого байта текста**. */
  quotient: 3,
  /** Временный: произведение, разряд, признак порога, адрес знака. */
  scratch: 4,
  /** Постоянная 10, затем **код минуса**. */
  ten: 5,
  /** Смещение слота разряда, затем **адрес слова-границы**. */
  offset: 6,
  /** Адрес площадки — основание адресации. */
  buffer: 7,
} as const;

/** Что листовая последовательность портит: ровно окно вызываемой — `%b[0..7]`. */
export const LEAN_PRINT_CLOBBERS: readonly number[] = Object.values(LEAN_PRINT_REGISTERS);

/**
 * ЧИСЛО → ТЕКСТ В ВОСЬМИ РЕГИСТРАХ: вход — `%b[0]`, выход — те же слова площадки.
 *
 * Результат тот же, что у {@link numberToTextPrimitives}: разряды, минус и `\n` в площадке плюс
 * слова «адрес текста» и «длина» — поэтому хвост {@link writeTextPrimitives} (он делается
 * ВЫЗЫВАЮЩИМ, где системный вызов возможен) сюда подходит без изменений.
 *
 * **Вход берётся из `%b[0]`**: у вызываемой это её `%r0` — то место, куда соглашение кладёт первый
 * аргумент (`%r(2*wbs)` вызывающего). Копировать значение не нужно — и это не мелочь: лишняя
 * команда в вызываемой означала бы лишний регистр.
 *
 * @param heapAddress адрес кучи образа — от него считается площадка
 */
export function numberToTextLeanPrimitives(heapAddress: number): NumberToText {
  const r = LEAN_PRINT_REGISTERS;
  const area = printAreaOf(heapAddress);
  const digitsBase = area + PRINT_AREA_LAYOUT.digits;
  const startWord = area + PRINT_AREA_LAYOUT.startWord;
  const lengthWord = area + PRINT_AREA_LAYOUT.lengthWord;
  const instructions: AsmInstruction[] = [];

  // 1. Константы — первыми (порядок обязателен: `1 − 2·знак` читает единицу; §3.40).
  instructions.push(movts(PRINT_BASE, r.ten), movtd(area, r.buffer), movts(1, r.offset));

  // 2. Знак и модуль. `shrs` логический, поэтому признак 1/0, а не −1/0.
  instructions.push(
    shrs(r.input, 31, r.negative),
    adds(r.negative, r.negative, r.scratch), // 2·знак
    subs(r.offset, r.scratch, r.scratch), // 1 − 2·знак
    muls(r.input, r.scratch, r.value), // модуль
    // Вход мёртв — его регистр берёт СЧЁТ разрядов (в полной последовательности это был `%b[8]`).
    movts(1, r.input),
  );

  // 3. Десять разрядов — прямыми шагами, без цикла и сравнений.
  for (let index = 0; index < PRINT_DIGITS; index++) {
    instructions.push(
      sdivs(r.value, r.ten, r.quotient),
      muls(r.quotient, r.ten, r.scratch),
      subs(r.value, r.scratch, r.scratch), // разряд
      addsImm(r.scratch, ASCII_ZERO, r.scratch), // код разряда
      movts(PRINT_AREA_LAYOUT.digits + PRINT_DIGITS - 1 - index, r.offset),
      stb(r.scratch, r.buffer, r.offset), // байтом в свой слот
      // Постоянной 9 у нас нет — материализуем её в освободившийся `scratch` (разряд уже в памяти).
      movts(PRINT_DIGITS - 1, r.scratch),
      subs(r.scratch, r.value, r.scratch), // 9 − v
      shrs(r.scratch, 31, r.scratch), // 1, если v ≥ 10
      adds(r.input, r.scratch, r.input), // счёт +=
      movtsReg(r.quotient, r.value), // v ← q
    );
  }

  // 4. Адрес текста, длина, знак и перевод строки — прямой арифметикой.
  instructions.push(
    movts(0, r.value), // постоянный ноль: значение больше не нужно, а нулевое смещение — нужно
    movts(PRINT_AREA_LAYOUT.digits + PRINT_DIGITS, r.scratch), // 12
    subs(r.scratch, r.input, r.scratch), // 10 − разряды
    subs(r.scratch, r.negative, r.scratch), // минус сдвигает текст на байт влево
    adds(r.buffer, r.scratch, r.quotient), // адрес текста
    movts(1, r.offset), // единица: адрес байта перед текстом
    subs(r.quotient, r.offset, r.scratch),
    adds(r.scratch, r.negative, r.scratch),
    movts(ASCII_MINUS, r.ten), // код минуса: `ten` после разбора свободен
    stb(r.ten, r.scratch, r.value), // минус байтом; у неотрицательного — вне текста
    adds(r.input, r.negative, r.input), // длина = разряды + знак
    addsImm(r.input, 1, r.input), // + перевод строки
    movts(ASCII_NEWLINE, r.ten),
    movts(PRINT_AREA_LAYOUT.newline, r.offset),
    stb(r.ten, r.buffer, r.offset),
    movtd(startWord, r.offset),
    std(r.quotient, r.offset, r.value),
    movtd(lengthWord, r.offset),
    std(r.input, r.offset, r.value),
  );

  return { instructions, area, digitsBase, signByte: digitsBase - 1, startWord, lengthWord };
}

/**
 * СТОРОЖ ЛИСТОВОЙ ПОСЛЕДОВАТЕЛЬНОСТИ: трогает ли она что-нибудь вне `%b[0..7]`.
 *
 * Проверяется ИМЯ регистра, а не замысел: у вызываемой окно восемь регистров, и обращение к
 * `%b[8]` там — ловушка на первой же команде тела (измерено, `.tmp/osnova-call-enter.ts`).
 * Оконные пересылки (`%rN`, `file: 'window'`) листовой последовательности запрещены по той же
 * причине: она не делает системных вызовов, а окно вызываемой — восемь регистров.
 */
export function leanSequenceProblems(instructions: readonly AsmInstruction[]): string[] {
  const allowed = new Set<number>(LEAN_PRINT_CLOBBERS);
  const problems: string[] = [];
  instructions.forEach((instruction, index) => {
    for (const operand of instruction.operands) {
      if (operand.kind !== 'reg') continue;
      if (operand.file === 'window') {
        problems.push(`#${String(index)} ${instruction.mnemonic}: оконный %r${String(operand.index)} — листовой последовательности нельзя`);
        continue;
      }
      if (!allowed.has(operand.index)) {
        problems.push(`#${String(index)} ${instruction.mnemonic}: %b[${String(operand.index)}] вне окна вызываемой (0…7)`);
      }
    }
  });
  return problems;
}

// ─────────────────────────────────────────────────────────────────────────────
// ХВОСТ: ОТДАТЬ ТЕКСТ НАРУЖУ
// ─────────────────────────────────────────────────────────────────────────────

/**
 * `write(fd, buf, count)` по словам площадки — тем же набором форм, что у «hello»
 * (`src/e2k/syscallRuntime.ts:97-115`).
 *
 * @param windowRsz размер окна для `setbn`: по умолчанию тот же, что ставит пролог образа
 *   (`ARRAY_WINDOW_RSZ = 7`, шестнадцать единиц — `%b[0..15]`). Меньшее значение **сужает** окно и
 *   делает `%b[12..15]` недоступными, поэтому по умолчанию берётся прологовое.
 */
export function writeTextPrimitives(
  heapAddress: number,
  windowRsz = ARRAY_WINDOW_RSZ,
  frame: SyscallFrame = ENTRY_SYSCALL_FRAME,
): AsmInstruction[] {
  const r = PRINT_PRIMITIVE_REGISTERS;
  const area = printAreaOf(heapAddress);
  const startWord = area + PRINT_AREA_LAYOUT.startWord;
  const lengthWord = area + PRINT_AREA_LAYOUT.lengthWord;
  return [
    // В ВЫРАЩЕННОМ КАДРЕ `setbn` НЕ СТАВИТСЯ: окно уже дал пролог процедуры, а повторная `setbn`
    // после `setwd` — ловушка `0x100008` (§3.56.2). В кадре точки входа — ставится, как раньше.
    ...(frame.setbn ? [setbn(windowRsz)] : []),
    movts(0, r.zero), // ноль понадобится как «второе слагаемое» при пересылке в оконный регистр
    movtd(startWord, r.offset),
    ldd(r.offset, r.zero, r.value), // адрес текста
    // Аргумент 2 — в оконный `%r10`: форма `adds регистр, ноль, %rN` измерена на выходе всех
    // программ корпуса (`src/e2k/programImage.ts:126-129`). Оконный приёмник — не прихоть:
    // `movts` регистр→оконный регистр в дереве не проверен, а эта форма работает.
    a('adds', [reg(r.value), reg(r.zero), window_(syscallWindowOf(frame, 2))]),
    movtd(lengthWord, r.offset),
    ldd(r.offset, r.zero, r.scratch), // длина
    a('adds', [reg(r.scratch), reg(r.zero), window_(syscallWindowOf(frame, 3))]), // аргумент 3
    a('movts', [imm(SYS_WRITE), window_(syscallWindowOf(frame, 0))]),
    a('movts', [imm(STDOUT_FD), window_(syscallWindowOf(frame, 1))]),
    a('sdisp', [imm(1), imm(0)]),
    a('call', [imm(1), imm(frame.wbs)]), // ширина вызова из кадра: 4 в точке входа, 8 в выращенном
  ];
}

/**
 * ВЫХОД ПРОГРАММЫ — обязательная часть печати, а не украшение.
 *
 * Измерено (`docs/hardware-debt.md` §3.39): программа **без возврата значения** на цели падает
 * (код 134, поток уходит за свой код), а `вернуть 0/1/2` даёт 0/1/2. Поэтому печатающая программа
 * завершается **своим** `exit`, а не отсутствием возврата.
 *
 * Окно здесь не ставится намеренно: его уже поставил либо {@link writeTextPrimitives}, либо пролог
 * образа. Отдельный `setbn` ставить **вредно**: он сужает окно (`docs/hardware-debt.md` §3.24).
 */
export function exitPrimitives(code = 0, frame: SyscallFrame = ENTRY_SYSCALL_FRAME): AsmInstruction[] {
  return [
    a('movts', [imm(SYS_EXIT), window_(syscallWindowOf(frame, 0))]),
    a('movts', [imm(code), window_(syscallWindowOf(frame, 1))]),
    a('sdisp', [imm(1), imm(0)]),
    a('call', [imm(1), imm(4)]),
  ];
}

/** Готовая программа печати одного числа: текст в площадке, `write`, свой `exit`. */
export interface PrintNumberSequence {
  readonly instructions: readonly AsmInstruction[];
  readonly area: number;
  readonly startWord: number;
  readonly lengthWord: number;
}

/** Собрать полную последовательность печати: число → текст → `write` → `exit`. */
export function printNumberPrimitives(
  argument: number,
  heapAddress: number,
  options: { readonly exitCode?: number; readonly windowRsz?: number } = {},
): PrintNumberSequence {
  const text = numberToTextPrimitives(argument, heapAddress);
  return {
    instructions: [
      ...text.instructions,
      ...writeTextPrimitives(heapAddress, options.windowRsz),
      ...exitPrimitives(options.exitCode ?? 0),
    ],
    area: text.area,
    startWord: text.startWord,
    lengthWord: text.lengthWord,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// СТОРОЖ ПОСЛЕДОВАТЕЛЬНОСТИ
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Сторож: проверяет **смысл** шагов, а не их наличие (по образцу `checkArraySequence`).
 *
 * Он же — материал негативного контроля: сними запись разряда, деление, счёт длины или саму
 * границу с хвостом — и он покраснеет с названной причиной.
 */
export function checkNumberToText(instructions: readonly AsmInstruction[]): string[] {
  const problems: string[] = [];
  const count = (mnemonic: string): number => instructions.filter((item) => item.mnemonic === mnemonic).length;
  if (count('sdivs') !== PRINT_DIGITS) {
    problems.push(`печать: делений ${String(count('sdivs'))}, а разрядов ${String(PRINT_DIGITS)}`);
  }
  if (count('stb') !== PRINT_DIGITS + 2) {
    problems.push(
      `печать: байтовых записей ${String(count('stb'))} — нужны ${String(PRINT_DIGITS)} разрядов, знак и перевод строки`,
    );
  }
  if (count('std') !== 2) {
    problems.push(`печать: слов-границ ${String(count('std'))}, а их две (адрес текста и длина)`);
  }
  if (count('ct') !== 0 || count('disp') !== 0 || count('call') !== 0) {
    problems.push('печать: в последовательности «число → текст» нет ни переходов, ни вызовов — только прямая развёртка');
  }
  if (count('shrs') !== PRINT_DIGITS + 1) {
    problems.push(`печать: сдвигов ${String(count('shrs'))} — один на знак и по одному на порог разряда`);
  }
  // Основание и смещение формы памяти обязаны быть РАЗНЫМИ регистрами: измерено
  // (`docs/hardware-debt.md` §3.30) — совпадение валит порт исключением при входе в блок.
  instructions.forEach((instruction, index) => {
    if (instruction.mnemonic !== 'ldd' && instruction.mnemonic !== 'std' && instruction.mnemonic !== 'stb') return;
    const base = instruction.operands[instruction.mnemonic === 'ldd' ? 0 : 1];
    const offset = instruction.operands[instruction.mnemonic === 'ldd' ? 1 : 2];
    if (base?.kind === 'reg' && offset?.kind === 'reg' && base.index === offset.index) {
      problems.push(
        `#${String(index)} ${instruction.mnemonic}: основание и смещение — один и тот же %b[${String(base.index)}]: ` +
          'порт взводит исключение (docs/hardware-debt.md §3.30)',
      );
    }
  });
  return problems;
}

/** Готовый кодировщик — для проб, которым нужны байты. */
export const printEncoder = getEncoder('e2k');
