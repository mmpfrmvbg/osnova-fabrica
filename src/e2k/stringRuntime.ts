/**
 * СТРОКИ НА ЦЕЛИ: СТАТИЧЕСКИЕ БАЙТЫ UTF-8, ДЛИНА В КОДОВЫХ ТОЧКАХ, СКЛЕЙКА В СТАТИЧЕСКИЙ БУФЕР.
 *
 * # Решения владельца, которые здесь исполняются
 *
 * 1. **Величина длины — КОДОВЫЕ ТОЧКИ**, а не байты и не UTF-16. В памяти строка лежит байтами
 *    UTF-8; `длина` считает кодпоинты **проходом по байтам**: продолжение — `0b10xxxxxx`.
 *    Проверка приёмки: `длина("🙂")` = **1** (в байтах было бы 4, в UTF-16 — 2).
 * 2. **Памяти НЕ вводим.** Строковый литерал — статические байты в образе (тот же приём, что у
 *    площадки печати: адрес известен на сборке, `movtd` кладёт его в регистр). Склейка пишет в
 *    **статический буфер** {@link STRING_BUFFER_BYTES} байт; переполнение — **названный отказ**,
 *    а не тихая порча соседних данных.
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
import { SYS_WRITE, STDOUT_FD, WINDOW_NUMBER_REGISTER } from './syscallRuntime';

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
} as const;

/**
 * ГРАНИЦА СКЛЕЙКИ — 20 байт, решение владельца.
 *
 * Не «сколько влезло»: буфер объявлен в карте образа, и всё, что длиннее, — НАЗВАННЫЙ ОТКАЗ на
 * сборке (длины статические, поэтому переполнение видно до прогона). Расширять буфер — значит
 * отнимать место у кода: буфер лежит в хвосте образа, перед площадкой печати.
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

/** Влезает ли склейка в буфер; причина отказа называет числа. */
export function concatFitsBuffer(firstBytes: number, secondBytes: number): string | undefined {
  const total = firstBytes + secondBytes;
  if (total <= STRING_BUFFER_BYTES) return undefined;
  return (
    `склейка строк: ${String(firstBytes)} + ${String(secondBytes)} = ${String(total)} байт, ` +
    `а статический буфер — ${String(STRING_BUFFER_BYTES)} байт (решение владельца, без памяти)`
  );
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
}): AsmInstruction[] {
  const write = (addressRegister: number, length: number): AsmInstruction[] => [
    a('adds', [reg(addressRegister), reg(ARRAY_REGISTERS.zero), window_(WINDOW_NUMBER_REGISTER + 2)]),
    a('movts', [imm(length), window_(WINDOW_NUMBER_REGISTER + 3)]),
    a('movts', [imm(SYS_WRITE), window_(WINDOW_NUMBER_REGISTER)]),
    a('movts', [imm(STDOUT_FD), window_(WINDOW_NUMBER_REGISTER + 1)]),
    a('sdisp', [imm(1), imm(0)]),
    a('call', [imm(1), imm(4)]),
  ];
  return [
    // Окно ставится как у рантайма массивов: без него системный вызов не принимается.
    a('setbn', [imm(ARRAY_WINDOW_RSZ), imm(0), imm(0)]),
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
      if (operand.index === ARRAY_REGISTERS.eight || operand.index === ARRAY_REGISTERS.heap) {
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
