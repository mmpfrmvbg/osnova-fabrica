/**
 * СТРОКИ НА ЦЕЛИ: СТАТИЧЕСКИЕ БАЙТЫ UTF-8, ДЛИНА В КОДОВЫХ ТОЧКАХ, СКЛЕЙКА В СТАТИЧЕСКИЙ БУФЕР.
 *
 * # Решения владельца, которые здесь исполняются
 *
 * 1. **Величина длины — КОДОВЫЕ ТОЧКИ**, а не байты и не UTF-16. В памяти строка лежит байтами
 *    UTF-8; `длина` считает кодпоинты **проходом по байтам**: продолжение — `0b10xxxxxx`.
 *    Проверка приёмки: `длина("🙂")` = **1** (в байтах было бы 4, в UTF-16 — 2).
 * 2. **Памяти НЕ вводим.** Строковый литерал — статические байты в образе (тот же приём, что у
 *    площадки печати: адрес известен на сборке, `movtd` кладёт его в регистр). Склейка до
 *    {@link STRING_BUFFER_BYTES} байт пишет в **статический буфер**; склейка сверх — берёт блок у
 *    **арены** (`src/e2k/arenaRuntime.ts`), и тогда отказ переезжает на её исчерпание: тихой порчи
 *    соседних данных нет ни в одном из двух случаев (решение владельца, 2026-09-29).
 * 3. US (`getsp`) — не здесь: это следующий заход.
 *
 * # Что такое значение строки на цели
 *
 * **Регистр со строкой держит АДРЕС её байтов.** Всё остальное — длина в байтах и длина в кодпоинтах —
 * известно на СБОРКЕ, потому что строки статические: литерал пришёл из пула, склейка идёт в буфер
 * фиксированного размера, третьего источника строк нет. Поэтому `длина` не «угадывает» число, а
 * СЧИТАЕТ его кодом: проход по байтам со сборки известной длины (см. {@link stringLengthInstructions}).
 * С появлением памяти тот же проход станет рантаймовым — форма команд не изменится, изменится лишь
 * то, откуда берётся длина в байтах.
 *
 * # Почему таблица продолжений, а не арифметика
 *
 * Проверка «байт — продолжение» — это `(байт & 0xc0) == 0x80`. Арифметикой она стоит 6–8 команд на
 * байт (сдвиг, вычитание, знак, нормализация), а **таблицей на 256 байт** — три: `ldb` байта, `ldb`
 * признака из таблицы, вычитание. Таблица лежит в образе статическими байтами и стоит 256 байт ОДИН
 * раз на программу. Без умножений, делений и ветвлений — то есть без предикатов, которых у нас нет.
 *
 * # Регистры
 *
 * `%b[10]`, `%b[11]` — временные рантайма массивов (`scratch`, `scratch2`), их портить можно.
 * `%b[12]` (ноль) и `%b[13]` (единица) — ПОСТОЯННЫЕ рантайма массивов: их значения восстанавливаются
 * (`movts 0` / `movts 1`), иначе массивная часть программы получила бы мусор вместо нуля и единицы.
 * `%b[14]` (восемь) и `%b[15]` (куча) не трогаются вовсе.
 */
import type { AsmInstruction, Operand } from './backend';
import { ARRAY_REGISTERS, ARRAY_WINDOW_RSZ } from './arrayRuntime';
import {
  ENTRY_SYSCALL_FRAME,
  SYS_WRITE,
  STDOUT_FD,
  SYSCALL_TRAP,
  syscallCallClose,
  syscallCallOpen,
  syscallWindowOf,
  type SyscallFrame,
} from './syscallRuntime';

const reg = (index: number): Operand => ({ kind: 'reg', index });
const imm = (value: number): Operand => ({ kind: 'imm', value });
const window_ = (index: number): Operand => ({ kind: 'reg', index, file: 'window' });
const literal = (value: number): Operand => ({ kind: 'imm64', value: BigInt(value) } as unknown as Operand);
const a = (mnemonic: string, operands: readonly Operand[], channel = 0): AsmInstruction => ({
  mnemonic,
  channel,
  operands,
});

/** Имена строковых операций, которые умеет рантайм (реестр: `src/runtime/vm/invokeRegistry.ts:55-56`). */
export const STRING_CALLS = {
  length: 'система.строка.длина',
  concat: 'система.строка.объединить',
  /**
   * КОД символа по индексу (решение владельца 2026-10-10, §3.133).
   *
   * Прежде эта операция в образ НЕ понижалась вовсе: она уходила в рантайм массивов и отказывала
   * «нет такой операции». После правки она понижается развёрткой на двух временных регистрах.
   */
  symbol: 'система.строка.символ',
} as const;

/**
 * НОСИТЕЛЬ САЙТА СКЛЕЙКИ СВЕРХ СТАТИЧЕСКОГО БУФЕРА: «выделить блок у арены и скопировать байты».
 *
 * Его ставит планирование строк (`src/e2k/stringPlan.ts`), когда сумма байтов больше
 * {@link STRING_BUFFER_BYTES}, а расширяет в носители **группа арены**
 * (`src/e2k/arenaRuntime.ts#arenaGroups`): выделение, проверка предела, переход в блок отказа и
 * копирование. Так у проверки предела ОДИН источник — тот же, что у `система.память.выделить`.
 *
 * Операнды: `[первая, вторая, приёмник, байтов первой, байтов второй]`.
 */
export const STRING_ARENA_CONCAT_CARRIER = 'IR.arena_concat';

/**
 * НОСИТЕЛЬ КОПИРОВАНИЯ В ВЫДЕЛЕННЫЙ БЛОК — то, во что разворачивается сайт склейки.
 *
 * Отдельное имя, а не «тот же носитель с другим смыслом»: до расширения носитель означает «выдели и
 * скопируй», после — только «скопируй» (выделение к тому времени стоит отдельным носителем).
 *
 * Операнды: `[первая, вторая, база-блок, байтов первой, байтов второй]`.
 */
export const STRING_ARENA_COPY_CARRIER = 'IR.string_arena_copy';

/**
 * ГРАНИЦА СТАТИЧЕСКОГО БУФЕРА СКЛЕЙКИ — 20 байт, решение владельца.
 *
 * Не «сколько влезло»: буфер объявлен в карте образа, и всё, что длиннее, уходит **в арену**
 * (решение владельца, 2026-09-29: отказ переехал на исчерпание). Расширять буфер — значит отнимать
 * место у кода: буфер лежит в хвосте образа, перед площадкой печати.
 */
export const STRING_BUFFER_BYTES = 20;

/** Таблица «байт — продолжение»: 256 байт, единица на `0b10xxxxxx`. */
export const STRING_TABLE_BYTES = 256;

/** Перевод строки дописывается печатью строки — как у чисел (§3.42.1). */
export const STRING_NEWLINE = 0x0a;

/**
 * Временные регистры строкового рантайма.
 *
 * `zero`/`one` — ПОСТОЯННЫЕ рантайма массивов (`%b[12]`, `%b[13]`): рантайм их портит и возвращает
 * прежние значения перед выходом (иначе `система.массив.*` получил бы мусор вместо нуля и единицы).
 */
export const STRING_REGISTERS = {
  /** Смещение чтения (временный рантайма массивов). */
  first: 10,
  /** Байт и признак продолжения (временный рантайма массивов). */
  second: 11,
  /** База таблицы или буфера — **портит ноль** рантайма массивов. */
  base: ARRAY_REGISTERS.zero,
  /** Смещение записи при склейке — **портит единицу** рантайма массивов. */
  write: ARRAY_REGISTERS.one,
} as const;

/** Отказ строкового рантайма: причина называется, а не замалчивается. */
export class StringRuntimeRefusal extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'StringRuntimeRefusal';
  }
}

/**
 * Регистры, которые портит ВЫВОД СТРОКИ: оконные аргументы `write` (`%r8..%r11`) и временный
 * `%b[10]` (адрес перевода строки). `%b[12]` (ноль рантайма массивов) только ЧИТАЕТСЯ.
 *
 * Набор меньше, чем у развёртки числа (`%b[0..11]` целиком): строка не преобразуется, её байты уже
 * лежат в образе. Поэтому сохранение живых вокруг печати строки дешевле — и это тот же механизм
 * (`planPrintSite` с другим набором порчимых регистров), а не второй список мест.
 */
export const STRING_PRINT_CLOBBERS: readonly number[] = [8, 9, 10, 11];

/** Байты строки в UTF-8. */
export function utf8Bytes(text: string): number[] {
  return [...Buffer.from(text, 'utf-8')];
}

/**
 * ДЛИНА В КОДОВЫХ ТОЧКАХ по байтам: продолжение — `0b10xxxxxx`.
 *
 * Это тот же проход, что делает код на цели (`stringLengthInstructions`), только собранный заранее.
 * Он нужен для проверок и для отчёта: сравнивать «сколько насчитал код» с «сколько должно быть»
 * обязан независимый счёт, иначе ошибка в кодогенерации останется незамеченной.
 */
export function codePointCount(bytes: readonly number[]): number {
  let count = 0;
  for (const byte of bytes) {
    if ((byte & 0xc0) !== 0x80) count += 1;
  }
  return count;
}

/** Таблица продолжений: 1 там, где байт — продолжение (`0b10xxxxxx`). */
export function continuationTable(): number[] {
  return Array.from({ length: STRING_TABLE_BYTES }, (_, byte) => ((byte & 0xc0) === 0x80 ? 1 : 0));
}

/**
 * ПОСЧИТАТЬ КОДОВЫЕ ТОЧКИ КОДОМ: `длина(строка)`, развёрнутая по числу байт.
 *
 * Счёт начинается с ЧИСЛА БАЙТОВ (оно известно на сборке) и уменьшается на единицу за каждый байт
 * продолжения — так «сколько кодпоинтов» получается без ветвлений.
 *
 * @param options.base регистр, в котором лежит АДРЕС байтов строки
 * @param options.byteLength сколько байт у этой строки (известно на сборке)
 * @param options.destination регистр результата
 * @param options.tableAddress адрес таблицы продолжений в образе
 */
export function stringLengthInstructions(options: {
  readonly base: number;
  readonly byteLength: number;
  readonly destination: number;
  readonly tableAddress: number;
}): AsmInstruction[] {
  const r = STRING_REGISTERS;
  const instructions: AsmInstruction[] = [
    a('movts', [imm(options.byteLength), reg(options.destination)]),
    a('movtd', [literal(options.tableAddress), reg(r.base)]),
    a('movts', [imm(0), reg(r.first)]),
  ];
  for (let index = 0; index < options.byteLength; index++) {
    instructions.push(
      // Читаем байт по текущему смещению, затем признак продолжения ИЗ ТАБЛИЦЫ (смещение — сам байт).
      a('ldb', [reg(options.base), reg(r.first), reg(r.second)], 0),
      a('ldb', [reg(r.base), reg(r.second), reg(r.write)], 0),
      // Кодпоинтов = байтов − продолжений.
      a('subs', [reg(options.destination), reg(r.write), reg(options.destination)]),
      a('adds', [reg(r.first), imm(1), reg(r.first)]),
    );
  }
  instructions.push(
    // Постоянные рантайма массивов возвращаются: ноль — на место, единица — на место.
    a('movts', [imm(0), reg(ARRAY_REGISTERS.zero)]),
    a('movts', [imm(1), reg(ARRAY_REGISTERS.one)]),
  );
  return instructions;
}

/**
 * РАЗМЕР ЗАПИСИ ТАБЛИЦЫ КОДОВ: восемь байт на кодпоинт.
 *
 * Почему восемь, а не два или четыре:
 *
 * * **Восемь — потому что читает `ldd`** (загрузка двойного слова): её форма в таблице раскладки уже
 *   есть (`printCommandForm`), а команда `muls` с литералом этой оболочкой не кодируется вовсе
 *   (замер: «литерал в длинной форме (ALS + ALES) не реализован»). Запись на восемь байт позволяет
 *   собрать смещение тремя удвоениями (`adds x, x, x`), не заводя новых форм.
 * * **Не два байта** (как у первой редакции этой таблицы): двух байт хватает только до U+FFFF, и
 *   эмодзи («🙂» = U+1F642) на цели отказали бы, тогда как VM их считает. Таблица на восемь байт
 *   вмещает любую кодовую точку Unicode — и расхождения «VM умеет, цель отказывает» не возникает.
 */
export const STRING_SYMBOL_ENTRY_BYTES = 8;

/**
 * СКОЛЬКО УДВОЕНИЙ СОБИРАЮТ СМЕЩЕНИЕ ЗАПИСИ: восемь байт — это три удвоения (`2³ = 8`).
 *
 * **Замер, а не догадка:** индекс `ldd` — БАЙТОВОЕ СМЕЩЕНИЕ, масштаба по размеру команды у неё нет.
 * Проба `.tmp/osnova-ldd-scale-probe.ts` (таблица `[0x61][0x430]`, читается запись 1): индекс 0 → 97
 * (запись 0), индекс 1 → **0** (байт со смещения 1), индекс 8 → **48** (младший байт записи 1). То
 * есть «номер записи» и «смещение» — РАЗНЫЕ вещи, и вторая редакция этой развёртки читала не то;
 * на нечётном смещении модель вставала исключением выравнивания.
 */
const STRING_SYMBOL_DOUBLINGS = 3;

/**
 * НА СКОЛЬКО СДВИГАТЬ, ЧТОБЫ ПРОЧИТАТЬ ЗНАК: тридцать один.
 *
 * Арифметика цели здесь **32-битная** (у 64-битных команд свой суффикс — `addd`/`subd`), и это
 * измерено, а не выведено из имени: `movts −3; shrs 31` даёт 1 — то есть сдвигается 32-битное
 * `0xFFFFFFFD`, а не 64-битное значение (`docs/hardware-debt.md` §3.133).
 */
const STRING_SIGN_SHIFT = 31;

/**
 * ТАБЛИЦА КОДОВ СТРОКИ: по восемь байт на кодпоинт, младшим байтом вперёд (порядок цели).
 *
 * Почему таблица, а не разбор UTF-8 в рантайме: строки на цели СТАТИЧЕСКИЕ, и «какой код у k-го
 * кодпоинта» — свойство ЗНАЧЕНИЯ, известное на сборке ровно так же, как его длина в байтах. Таблица
 * продолжений (`continuationTable`) устроена так же: её тоже считает сборка, а читает рантайм.
 * Индекс при этом остаётся РАНТАЙМОВЫМ — выбирает рантайм, а не подставляет готовый ответ.
 *
 * Когда появятся строки из памяти (сегодня их нет: третий источник строк — это работа с файлами),
 * таблицу придётся заменить разбором байтов: у неизвестных на сборке байтов таблицы быть не может.
 */
export function symbolTableBytes(text: string): number[] {
  return symbolTableBytesOf(utf8Bytes(text));
}

/**
 * КОДОВЫЕ ТОЧКИ ИЗ БАЙТОВ UTF-8 — разбор НА СБОРКЕ (обратная сторона `utf8Bytes`).
 *
 * Нужен там, где текста значения уже нет, а байты есть: у склейки ключ значения составной
 * (`первая\u0000вторая`), а байты — настоящие. Поэтому коды берутся из байтов, а не из ключа.
 */
export function codePointsOfBytes(bytes: readonly number[]): number[] {
  const points: number[] = [];
  for (let at = 0; at < bytes.length; ) {
    const first = bytes[at]!;
    if ((first & 0x80) === 0) {
      points.push(first);
      at += 1;
      continue;
    }
    const length = (first & 0xe0) === 0xc0 ? 2 : (first & 0xf0) === 0xe0 ? 3 : 4;
    let code = first & (0xff >> (length + 1));
    for (let offset = 1; offset < length; offset++) code = (code << 6) | ((bytes[at + offset] ?? 0) & 0x3f);
    points.push(code);
    at += length;
  }
  return points;
}

/** Та же таблица кодов, но по БАЙТАМ значения (см. {@link codePointsOfBytes}). */
export function symbolTableBytesOf(bytes: readonly number[]): number[] {
  const table: number[] = [];
  for (const point of codePointsOfBytes(bytes)) {
    // Старшие четыре байта записи — НУЛИ: кодовая точка Unicode не выходит за 21 бит. Сдвиг больше
    // 31 в JavaScript заворачивается по модулю 32 (`1072 >> 32` = 1072), поэтому нули пишутся явно,
    // а не «сдвигом, который и так даст ноль» — это и был бы скрытый повтор младших байтов.
    for (let at = 0; at < STRING_SYMBOL_ENTRY_BYTES; at++) table.push(at < 4 ? (point >> (8 * at)) & 0xff : 0);
  }
  return table;
}

/**
 * КОД СИМВОЛА ПО ИНДЕКСУ: `символ(строка, индекс)` — без ветвлений, без разбора UTF-8.
 *
 * # Что делает последовательность
 *
 * 1. **Границы без ветвления.** `в границах = (индекс < кодпоинтов) и (индекс >= 0)` собирается из
 *    ДВУХ логических сдвигов (см. «почему логический»): `(индекс >= кодпоинтов)` — знак от
 *    `кодпоинтов − индекс − 1`, `(индекс < 0)` — знак самого индекса, `в границах = 1 − оба`.
 * 2. **Безопасный индекс:** `индекс · в границах` — при выходе за границу это ноль, и чтение
 *    таблицы остаётся внутри её памяти. Это не «мягкая обработка»: ответ ниже всё равно −1.
 * 3. **Смещение записи:** номер кодпоинта × 8 тремя удвоениями (`ldd` масштаба не имеет — замер
 *    `.tmp/osnova-ldd-scale-probe.ts`: индекс — БАЙТОВОЕ смещение).
 * 4. **Одно чтение таблицы** (`ldd`) по этому смещению.
 * 5. **Вне границ — `−1`**: `код·в границах + в границах − 1`. В границах это код, вне — −1, и
 *    никакое законное значение кода с −1 не спутать (коды неотрицательны). У VM на этот случай
 *    НАЗВАННЫЙ ОТКАЗ; у цели исключений нет, и разница записана (§3.133).
 *
 * # Почему ЗНАК берётся логическим сдвигом, а не арифметическим
 *
 * Замер `.tmp/osnova-symbol-micro-probe.ts`: `movts −3; shrs %b[9], 31, %b[10]` даёт **1**, а не −1.
 * То есть `shrs` этой оболочки заполняет нулями, и «взять знак сдвигом» негодно: прежняя редакция
 * считала `в границах` через знак и получала −1 вместо 1 — в границах отвечала мусором, а вне границ
 * «случайно верно». Разница видна только на различающей паре (индекс в границах и вне), поэтому и
 * записана замером. Сам знак берётся **соглашением**: `x ≥ 0` ⟺ `x >>> 31 = 0`, `x < 0` ⟺ `1`.
 *
 * # Почему это работает на двух временных регистрах
 *
 * Свободных временных у рантайма ДВА (`%b[10]`, `%b[11]`): `%b[12]` и `%b[13]` — постоянные нуля и
 * единицы рантайма массивов, `%b[14]`/`%b[15]` не трогаются вовсе. Здесь этого хватает: пока идёт
 * чтение таблицы, заняты только `%b[11]` (смещение записи) и приёмник, а `%b[10]` (признак границ)
 * живёт через чтение — потому что склейки байтов нет вовсе (запись целиком читается одной `ldd`).
 *
 * @param options.index регистр индекса: только ЧИТАЕТСЯ (в нём может лежать живая переменная)
 * @param options.destination регистр-приёмник
 * @param options.codePoints сколько кодпоинтов в строке (= число записей таблицы)
 * @param options.tableAddress адрес таблицы кодов в образе
 */
export function stringSymbolInstructions(options: {
  readonly index: number;
  readonly destination: number;
  readonly codePoints: number;
  readonly tableAddress: number;
}): AsmInstruction[] {
  const r = STRING_REGISTERS;
  const zero = ARRAY_REGISTERS.zero;
  const one = ARRAY_REGISTERS.one;
  return [
    // ЕДИНИЦА — СВОЯ, А НЕ ЧУЖАЯ ПОСТОЯННАЯ (шаг 2.3, случай 73). Прежде последовательность ЧИТАЛА
    // `%b[13]` как единицу рантайма массивов, и это верно ТОЛЬКО в плоскости точки входа: там единицу
    // ставит пролог образа. В плоскости ВЫЗЫВАЕМОЙ пролог ставит только НОЛЬ (`%b[12]`, §3.166 —
    // носитель `IR.callee_zero`), а `%b[13]` — обычная клетка её бюджета, и чтение «единицы» взяло бы
    // значение программы. Поэтому единица ставится ЗДЕСЬ, до первого использования: в плоскости входа
    // это тождественная запись (там уже 1), в плоскости вызываемой — единственный способ её иметь.
    // Форма от плоскости не зависит (§3.135): список команд один и тот же.
    a('movts', [imm(1), reg(one)]),
    // ГРАНИЦЫ: `в границах` собирается в `%b[10]`, безопасный индекс — в `%b[11]`.
    a('subs', [imm(options.codePoints), reg(options.index), reg(r.first)]),
    a('subs', [reg(r.first), reg(one), reg(r.first)]),
    a('shrs', [reg(r.first), imm(STRING_SIGN_SHIFT), reg(r.first)]),
    a('shrs', [reg(options.index), imm(STRING_SIGN_SHIFT), reg(r.second)]),
    a('adds', [reg(r.first), reg(r.second), reg(r.first)]),
    a('subs', [reg(one), reg(r.first), reg(r.first)]),
    a('muls', [reg(options.index), reg(r.first), reg(r.second)]),
    // СМЕЩЕНИЕ ЗАПИСИ: номер кодпоинта × 8 — тремя удвоениями (у `ldd` масштаба нет, см. выше).
    ...Array.from({ length: STRING_SYMBOL_DOUBLINGS }, () => a('adds', [reg(r.second), reg(r.second), reg(r.second)])),
    // ЧТЕНИЕ: база — приёмник, индекс — БАЙТОВОЕ СМЕЩЕНИЕ записи.
    a('movtd', [literal(options.tableAddress), reg(options.destination)]),
    a('ldd', [reg(options.destination), reg(r.second), reg(options.destination)]),
    // ВНЕ ГРАНИЦ — `−1`; в границах — сам код.
    a('muls', [reg(options.destination), reg(r.first), reg(options.destination)]),
    a('adds', [reg(options.destination), reg(r.first), reg(options.destination)]),
    a('subs', [reg(options.destination), reg(one), reg(options.destination)]),
  ];
}

/**
 * ДЕСКРИПТОР СТРОКИ: ЗНАЧЕНИЕ, КОТОРОЕ СБОРКЕ НЕ ИЗВЕСТНО, ЧИТАЕТСЯ ИЗ ПАМЯТИ (TD-0001).
 *
 * ═══ ЗАЧЕМ ═════════════════════════════════════════════════════════════════════════════════════════
 *
 * Шаг 2.3 берёт СТРОКОВОСТЬ из объявленного типа параметра, но длину и таблицу кодов — из
 * доказательства: все прямые сайты вызова обязаны передать одну и ту же известную строку. Параметр,
 * которому РАЗНЫЕ сайты передают РАЗНЫЕ строки, отказывал по имени. Приказ владельца 2026-11-05 —
 * снять этот отказ (TD-0001): «значение Строка-параметра известно рантайму».
 *
 * ═══ ПОЧЕМУ НЕ ПРОХОД ПО БАЙТАМ, ХОТЯ ПРИКАЗ БЫЛ О НЁМ ═════════════════════════════════════════════
 *
 * Проход по байтам требует ПЕРЕХОДА ВНУТРИ последовательности, а его негде взять — это замер, а не
 * оценка:
 *
 * * раскладка размещает только носители `IR.*`; голая команда без носителя не размещается;
 * * байтового шага среди носителей НЕТ (`IR.load` — это `ldd`, восемь байт), сдвига и маски — тоже;
 * * байтовый шаг выразим только ВНУТРИ составного носителя, а составной носитель строит свои команды
 *   сам и внутреннего перехода выразить не может: переходы существуют ТОЛЬКО как носители;
 * * значит, цикл требует НОВОГО носителя — правки `src/e2k/twoPassLayout.ts`, которые границами атома
 *   закрыты («только `src/e2k/**`» здесь означает «стену раскладки не трогать»: она держит закреплённые
 *   числа пяти ядер и корпус).
 *
 * Вместо прохода сделана выборка O(1) БЕЗ ветвлений: ПЕРЕД байтами каждой статической строки лежит
 * дескриптор из двух восьмибайтовых слов.
 *
 * ═══ ФОРМАТ (он же — договор между раскладкой статики и рантаймом) ═════════════════════════════════
 *
 * ```
 *   адрес байтов строки A (8-кратный):
 *     [A − 16]  слово 0: число КОДПОИНТОВ строки
 *     [A −  8]  слово 1: адрес ТАБЛИЦЫ КОДОВ этой строки (0 — таблицы нет)
 *     [A      ]  байты строки в UTF-8
 * ```
 *
 * Почему ровно так: адрес значения рантайм и так получает (Строка на цели — АДРЕС её байтов, ABI не
 * менялся), поэтому «значение» приходит ДАННЫМИ, а не из сборки, и специализация на каждый сайт не
 * нужна. Выравнивание на восемь обязательно: слова читает `ldd`, а она требует кратности восьми (замер
 * §3.133: невыровненная таблица — исключение выравнивания и таймаут модели).
 *
 * ═══ ГРАНИЦА МЕХАНИЗМА ═══════════════════════════════════════════════════════════════════════════════
 *
 * Дескриптор есть только у БЛОБА, лежащего в статике. У значения, собранного в рантайме (склейка в
 * буфере или в арене, нагрузка пары), его нет — читать `addr − 16` там значило бы читать чужие байты.
 * Поэтому конвейер включает этот путь ТОЛЬКО там, где КАЖДЫЙ сайт вызова передаёт литерал из пула
 * (`src/e2k/stringPlan.ts`); во всех прочих случаях остаётся названный отказ.
 */
export const STRING_DESCRIPTOR_BYTES = 16;

/**
 * ПОМЕТКА НОСИТЕЛЯ «ЗНАЧЕНИЕ ВОЗЬМИ ИЗ ДЕСКРИПТОРА».
 *
 * Числа байтов, кодпоинтов и адреса таблицы неотрицательны, поэтому −1 не может быть настоящей
 * пометкой. Ноль вместо «нет пометки» не годится: тогда исчезла бы разница между «сборка не смогла» и
 * «сборка решила», и отказ «носитель не несёт длину» перестал бы что-либо ловить.
 */
export const STRING_DESCRIPTOR_MARK = -1;

/**
 * СЛОВА ДЕСКРИПТОРА: байты для статики (`['адрес' − 16, 'адрес')`), МЛАДШИМ БАЙТОМ ВПЕРЁД.
 *
 * Порядок тот же, что у таблицы кодов ({@link symbolTableBytesOf}): цель читает слова `ldd`, а она на
 * этой оболочке читает младшим байтом вперёд — проверено таблицей кодов (замер §3.133).
 *
 * ═══ ЛОВУШКА, НА КОТОРОЙ СТОЯЛА ПЕРВАЯ РЕДАКЦИЯ (замер 2026-11-05) ════════════════════════════════
 *
 * Сдвиг на 32 и больше в JavaScript **не сдвигает, а ЗАВОРАЧИВАЕТ** по модулю 32: `3 >>> 32` — это
 * `3`, а не ноль. Первая редакция писала слово циклом `word >>> (8 * at)`, и четырёхбайтовое число
 * ложилось в ОБЕ половины восьмибайтового слова:
 *
 *   слово 0: 02 00 00 00 02 00 00 00   ← число кодпоинтов, повторённое
 *   слово 1: FA FF 10 00 FA FF 10 00   ← адрес таблицы, повторённый
 *
 * Это не рассуждение, а прочитанные байты образа (`.tmp/td1-дескриптор-байты.ts`). Цена: `ldd`
 * приносил длину `0x2_00000002` вместо `2`, а адрес таблицы — `0x10FFFA_00000000` вместо `0x10FFFA`,
 * то есть код символа читал память по чужому (нулевому) адресу. Проба длины при этом **печатала
 * верное `2`**: печать на цели отдаёт ТОЛЬКО младшие 32 разряда (§3.43), и мусор в старших через неё
 * невидим вовсе. Отсюда правило: у этого механизма младшая половина слова — не доказательство, и
 * стеречь его обязан не вывод печати, а ГРАНИЦА (`с[н]` при недоказанном значении: мусор в числе
 * кодпоинтов пропустил бы индекс за конец строки и вернул бы чужой код вместо −1).
 *
 * Пишутся нули ЯВНО (`at < 4`), как и у {@link symbolTableBytesOf}: это тот же дефект, названный там
 * двумя экранами выше, — и повторённый здесь.
 */
export function stringDescriptorBytes(count: number, tableAddress: number): number[] {
  const bytes: number[] = [];
  for (const word of [count, tableAddress]) {
    for (let at = 0; at < STRING_SYMBOL_ENTRY_BYTES; at++) {
      // ЗНАЧЕНИЯ — 32-битные (адрес образа и счёт кодпоинтов вне 32 разрядов не выходят): старшие
      // четыре байта слова — НУЛИ, и пишутся они именно нулями, а не «сдвигом, который и так даст ноль».
      bytes.push(at < 4 ? Math.floor(word / 2 ** (at * 8)) % 256 : 0);
    }
  }
  return bytes;
}

/**
 * ДЛИНА В КОДПОИНТАХ — ИЗ ДЕСКРИПТОРА (шесть команд, без ветвлений и без чтения байтов).
 *
 * Прежний путь ({@link stringLengthInstructions}) считает кодпоинты на СБОРКЕ: он разворачивает по
 * одной команде на каждый байт и потому требует известной длины. Здесь известно только то, что по
 * адресу лежит строка: число кодпоинтов приходит из её дескриптора.
 *
 * Почему шестнадцать кладётся `movts`, а не вычитается литералом: `subs` с литералом больше 15
 * раскладка считает ВОСЬМЬЮ байтами, а кодировщик — шестнадцатью (`printCall.ts` берёт размер `subs`
 * по мнемонике, а `e2k-real.ts` — по значению литерала). Это расхождение в этом механизме
 * недопустимо: у `movts` размер считается по значению (`immediateSize`), и обе стороны сходятся.
 *
 * @param options.base регистр, в котором лежит АДРЕС байтов строки (только читается)
 * @param options.destination регистр результата — число кодпоинтов
 */
export function stringLengthFromDescriptorInstructions(options: {
  readonly base: number;
  readonly destination: number;
}): AsmInstruction[] {
  const r = STRING_REGISTERS;
  const zero = ARRAY_REGISTERS.zero;
  return [
    // ШЕСТНАДЦАТЬ — в `%b[13]` (своя единица ставится последней; здесь это просто число).
    a('movts', [imm(STRING_DESCRIPTOR_BYTES), reg(ARRAY_REGISTERS.one)]),
    // АДРЕС ДЕСКРИПТОРА: `%b[10] = адрес − 16`.
    a('subs', [reg(options.base), reg(ARRAY_REGISTERS.one), reg(r.first)]),
    // СМЕЩЕНИЕ ЧТЕНИЯ — ноль (`ldd` складывает базу и индекс; смещения в команде не нужно).
    a('movts', [imm(0), reg(zero)]),
    a('ldd', [reg(r.first), reg(zero), reg(options.destination)]),
    // ПОСТОЯННЫЕ РАНТАЙМА МАССИВОВ ВОЗВРАЩАЮТСЯ: ноль — на место, единица — на место.
    a('movts', [imm(0), reg(zero)]),
    a('movts', [imm(1), reg(ARRAY_REGISTERS.one)]),
  ];
}

/**
 * КОД СИМВОЛА ПО ИНДЕКСУ — ИЗ ДЕСКРИПТОРА: длина и таблица приходят из памяти, индекс — рантаймовый.
 *
 * Арифметика границ и чтения — ТА ЖЕ, что у {@link stringSymbolInstructions} (два логических сдвига,
 * безопасный индекс, три удвоения, `−1` вне границ): здесь меняется только ОТКУДА берутся число
 * кодпоинтов и адрес таблицы. Числа кодпоинтов на сборке не знает никто, поэтому последовательность
 * одна и та же для строк любой длины (у доказанного пути она зависела от числа кодпоинтов только
 * первым `subs` с литералом).
 *
 * @param options.base регистр с адресом байтов строки (только читается)
 * @param options.index регистр индекса: только ЧИТАЕТСЯ
 * @param options.destination регистр-приёмник
 */
export function stringSymbolFromDescriptorInstructions(options: {
  readonly base: number;
  readonly index: number;
  readonly destination: number;
}): AsmInstruction[] {
  const r = STRING_REGISTERS;
  const zero = ARRAY_REGISTERS.zero;
  const one = ARRAY_REGISTERS.one;
  return [
    // ЕДИНИЦА — СВОЯ (шаг 2.3): в плоскости вызываемой `%b[13]` — обычная клетка её бюджета.
    a('movts', [imm(1), reg(one)]),
    // СМЕЩЕНИЕ ЧТЕНИЯ — ноль; шестнадцать кладётся в `%b[10]` и там же становится адресом дескриптора.
    a('movts', [imm(0), reg(zero)]),
    a('movts', [imm(STRING_DESCRIPTOR_BYTES), reg(r.first)]),
    a('subs', [reg(options.base), reg(r.first), reg(r.first)]),
    // СЛОВО 0 — число кодпоинтов (живёт в `%b[11]` до конца арифметики границ).
    a('ldd', [reg(r.first), reg(zero), reg(r.second)]),
    // СЛОВО 1 — адрес таблицы кодов; едет прямо в приёмник, как `movtd` у доказанного пути.
    a('adds', [reg(r.first), imm(STRING_SYMBOL_ENTRY_BYTES), reg(r.first)]),
    a('ldd', [reg(r.first), reg(zero), reg(options.destination)]),
    // ГРАНИЦЫ: `в границах` — в `%b[10]`, безопасный индекс — в `%b[11]`.
    a('subs', [reg(r.second), reg(options.index), reg(r.first)]),
    a('subs', [reg(r.first), reg(one), reg(r.first)]),
    a('shrs', [reg(r.first), imm(STRING_SIGN_SHIFT), reg(r.first)]),
    a('shrs', [reg(options.index), imm(STRING_SIGN_SHIFT), reg(r.second)]),
    a('adds', [reg(r.first), reg(r.second), reg(r.first)]),
    a('subs', [reg(one), reg(r.first), reg(r.first)]),
    a('muls', [reg(options.index), reg(r.first), reg(r.second)]),
    // СМЕЩЕНИЕ ЗАПИСИ: номер кодпоинта × 8 — тремя удвоениями (у `ldd` масштаба нет).
    ...Array.from({ length: STRING_SYMBOL_DOUBLINGS }, () => a('adds', [reg(r.second), reg(r.second), reg(r.second)])),
    // ЧТЕНИЕ: база — приёмник (там адрес таблицы из дескриптора).
    a('ldd', [reg(options.destination), reg(r.second), reg(options.destination)]),
    // ВНЕ ГРАНИЦ — `−1`; в границах — сам код.
    a('muls', [reg(options.destination), reg(r.first), reg(options.destination)]),
    a('adds', [reg(options.destination), reg(r.first), reg(options.destination)]),
    a('subs', [reg(options.destination), reg(one), reg(options.destination)]),
    // ПОСТОЯННЫЕ РАНТАЙМА МАССИВОВ ВОЗВРАЩАЮТСЯ.
    a('movts', [imm(0), reg(zero)]),
    a('movts', [imm(1), reg(one)]),
  ];
}

/**
 * СКЛЕЙКА: байты первой строки, затем второй — в статический буфер; адрес буфера едет в приёмник.
 *
 * Переполнение здесь не проверяется: длины статические, и решение принимает конвейер
 * ({@link concatFitsBuffer}), который обязан отказать ДО сборки образа.
 */
export function stringConcatInstructions(options: {
  readonly first: number;
  readonly second: number;
  readonly destination: number;
  readonly bufferAddress: number;
  readonly firstBytes: number;
  readonly secondBytes: number;
}): AsmInstruction[] {
  const r = STRING_REGISTERS;
  const copy = (source: number, sourceOffsetStart: number, writeOffsetStart: number, bytes: number): AsmInstruction[] => {
    const instructions: AsmInstruction[] = [
      a('movts', [imm(sourceOffsetStart), reg(r.first)]),
      a('movts', [imm(writeOffsetStart), reg(r.write)]),
    ];
    for (let index = 0; index < bytes; index++) {
      instructions.push(
        a('ldb', [reg(source), reg(r.first), reg(r.second)], 0),
        a('stb', [reg(r.second), reg(r.base), reg(r.write)], 2),
        a('adds', [reg(r.first), imm(1), reg(r.first)]),
        a('adds', [reg(r.write), imm(1), reg(r.write)]),
      );
    }
    return instructions;
  };
  return [
    a('movtd', [literal(options.bufferAddress), reg(r.base)]),
    ...copy(options.first, 0, 0, options.firstBytes),
    ...copy(options.second, 0, options.firstBytes, options.secondBytes),
    // Приёмник — АДРЕС результата (значение строки на цели — адрес её байтов).
    a('movtd', [literal(options.bufferAddress), reg(options.destination)]),
    a('movts', [imm(0), reg(ARRAY_REGISTERS.zero)]),
    a('movts', [imm(1), reg(ARRAY_REGISTERS.one)]),
  ];
}

/**
 * СКЛЕЙКА В ВЫДЕЛЕННЫЙ БЛОК: те же байты, но приёмник — АДРЕС БЛОКА, а не статический буфер.
 *
 * # Чем отличается от статической редакции — и чем НЕ отличается
 *
 * | | статическая | в блоке арены |
 * |---|---|---|
 * | откуда база записи | `movtd` адреса буфера в `%b[12]` | **регистр** с адресом блока: его положило выделение |
 * | куда едет результат | `movtd` адреса буфера | ничего: адрес уже в приёмнике выделения |
 * | постоянные рантайма массивов | возвращаются ноль и единица | возвращается только единица: ноль не тронут |
 *
 * Копирование — те же команды (`ldb`/`stb`/`adds`), потому что и работа та же. База — **регистр
 * приёмника выделения**: `%b[12]` для этого не годится, там ноль рантайма массивов, а его портить
 * и возвращать значило бы делать лишнюю работу.
 *
 * Ожидание исчерпания арены — НЕ здесь: блок выделяет и проверяет предел арена
 * (`src/e2k/arenaRuntime.ts`), и до этой последовательности управление доходит только если предел цел.
 */
export function stringArenaCopyInstructions(options: {
  readonly first: number;
  readonly second: number;
  /** Регистр-приёмник выделения: в нём лежит адрес выделенного блока. */
  readonly base: number;
  readonly firstBytes: number;
  readonly secondBytes: number;
}): AsmInstruction[] {
  const r = STRING_REGISTERS;
  const copy = (source: number, writeOffsetStart: number, bytes: number): AsmInstruction[] => {
    const instructions: AsmInstruction[] = [
      a('movts', [imm(0), reg(r.first)]),
      a('movts', [imm(writeOffsetStart), reg(r.write)]),
    ];
    for (let index = 0; index < bytes; index++) {
      instructions.push(
        a('ldb', [reg(source), reg(r.first), reg(r.second)], 0),
        a('stb', [reg(r.second), reg(options.base), reg(r.write)], 2),
        a('adds', [reg(r.first), imm(1), reg(r.first)]),
        a('adds', [reg(r.write), imm(1), reg(r.write)]),
      );
    }
    return instructions;
  };
  return [
    ...copy(options.first, 0, options.firstBytes),
    ...copy(options.second, options.firstBytes, options.secondBytes),
    // Единица рантайма массивов возвращается: смещение записи заняло её место.
    a('movts', [imm(1), reg(ARRAY_REGISTERS.one)]),
  ];
}

/**
 * ВЛЕЗАЕТ ЛИ СКЛЕЙКА В СТАТИЧЕСКИЙ БУФЕР — и это РЕШЕНИЕ О СПОСОБЕ, а не отказ.
 *
 * Было: «не влезло — названный отказ на сборке». Стало (решение владельца, 2026-09-29): не влезло —
 * склейка идёт **через арену**: блок выделяется в рантайме ровно под сумму байтов, байты копируются
 * в него, а отказ **переезжает на исчерпание** арены (`src/e2k/arenaRuntime.ts` — код 231 и строка
 * в stderr). Граница осталась той же: **20 байт статики**, всё сверх — арена.
 */
export function concatFitsBuffer(firstBytes: number, secondBytes: number): boolean {
  return firstBytes + secondBytes <= STRING_BUFFER_BYTES;
}

/**
 * ВЫВОД СТРОКИ: байты наружу `write`, следом перевод строки — вторым `write`.
 *
 * Второй вызов, а не один, потому что перевод строки лежит ОТДЕЛЬНЫМ статическим байтом: дописать
 * его к строке нельзя — строки константные, и в памяти их портить нечем (буфера для каждой печати
 * нет). Оба вызова видны в журнале модели, и сторож сравнивает БАЙТЫ вывода, а не число вызовов.
 */
export function stringWriteInstructions(options: {
  readonly address: number;
  readonly byteLength: number;
  readonly newlineAddress: number;
  /** Кадр: в точке входа окно ставится своим `setbn`, в выращенном — уже стоит прологом. */
  readonly frame?: SyscallFrame;
}): AsmInstruction[] {
  const frame = options.frame ?? ENTRY_SYSCALL_FRAME;
  const write = (addressRegister: number, length: number): AsmInstruction[] => [
    a('adds', [reg(addressRegister), reg(ARRAY_REGISTERS.zero), window_(syscallWindowOf(frame, 2))]),
    a('movts', [imm(length), window_(syscallWindowOf(frame, 3))]),
    a('movts', [imm(SYS_WRITE), window_(syscallWindowOf(frame, 0))]),
    a('movts', [imm(STDOUT_FD), window_(syscallWindowOf(frame, 1))]),
    ...syscallCallOpen(frame),
    a('sdisp', [imm(1), imm(SYSCALL_TRAP)]),
    a('call', [imm(1), imm(frame.wbs)]),
    ...syscallCallClose(frame),
  ];
  return [
    // Окно ставится как у рантайма массивов — но ТОЛЬКО в кадре точки входа: в выращенном кадре
    // окно уже дал пролог, а повторная `setbn` после `setwd` — ловушка (§3.56.2).
    ...(frame.setbn ? [a('setbn', [imm(ARRAY_WINDOW_RSZ), imm(0), imm(0)])] : []),
    ...write(options.address, options.byteLength),
    a('movtd', [literal(options.newlineAddress), reg(STRING_REGISTERS.first)]),
    ...write(STRING_REGISTERS.first, 1),
  ];
}

/**
 * Куда команда пишет результат — или `undefined`, если не пишет никуда.
 *
 * Нужно сторожу ниже: «трогает» и «портит» — разные вещи. Вывод строки ЧИТАЕТ ноль рантайма
 * массивов (`adds значение, ноль, %r10`) и не портит его — значит и восстанавливать нечего.
 */
function destinationOfInstruction(instruction: AsmInstruction): number | undefined {
  const last = instruction.operands[instruction.operands.length - 1];
  switch (instruction.mnemonic) {
    case 'movts':
    case 'movtd':
      return instruction.operands[1]?.kind === 'reg' ? (instruction.operands[1] as { index: number }).index : undefined;
    case 'adds':
    case 'subs':
    case 'muls':
    case 'sdivs':
    case 'shrs':
    case 'ldb':
    case 'ldd':
      return last?.kind === 'reg' ? (last as { index: number }).index : undefined;
    default:
      return undefined;
  }
}

/**
 * СТОРОЖ СТРУКТУРЫ: что строковый рантайм делает с регистрами.
 *
 * Проверяется то, на чём легко ошибиться молча: `%b[14]` (восемь) и `%b[15]` (куча) рантайма
 * массивов не трогаются вовсе (ни чтением, ни записью), а постоянные `%b[12]` (ноль) и `%b[13]`
 * (единица) возвращаются на место, ЕСЛИ были испорчены. Проверяются имена регистров, а не замысел.
 */
export function stringSequenceProblems(instructions: readonly AsmInstruction[]): string[] {
  const problems: string[] = [];
  const clobbered = new Set<number>();
  for (const [index, instruction] of instructions.entries()) {
    for (const operand of instruction.operands) {
      if (operand.kind !== 'reg') continue;
      if (operand.index === ARRAY_REGISTERS.eight || operand.index === ARRAY_REGISTERS.heapSlot) {
        problems.push(
          `#${String(index)} ${instruction.mnemonic}: тронут %b[${String(operand.index)}] — это ` +
            'постоянные рантайма массивов (восемь и куча), их строковый рантайм не трогает',
        );
      }
    }
    const destination = destinationOfInstruction(instruction);
    if (destination !== undefined) clobbered.add(destination);
  }
  const restoresZero = instructions.some((instruction) => {
    if (instruction.mnemonic !== 'movts') return false;
    const [value, destination] = instruction.operands;
    return value?.kind === 'imm' && value.value === 0 && destination?.kind === 'reg' && destination.index === ARRAY_REGISTERS.zero;
  });
  const restoresOne = instructions.some((instruction) => {
    if (instruction.mnemonic !== 'movts') return false;
    const [value, destination] = instruction.operands;
    return value?.kind === 'imm' && value.value === 1 && destination?.kind === 'reg' && destination.index === ARRAY_REGISTERS.one;
  });
  if (clobbered.has(ARRAY_REGISTERS.zero) && !restoresZero) {
    problems.push('ноль рантайма массивов (%b[12]) испорчен и не возвращён: `movts 0` в конце не найден');
  }
  if (clobbered.has(ARRAY_REGISTERS.one) && !restoresOne) {
    problems.push('единица рантайма массивов (%b[13]) испорчена и не возвращена: `movts 1` в конце не найден');
  }
  return problems;
}
