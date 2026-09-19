/**
 * РАНТАЙМ МАССИВОВ e2k: ЗАМЕНА `IR.invoke` РЕАЛЬНЫМИ ОБРАЩЕНИЯМИ К ПАМЯТИ.
 *
 * # Почему это нужно
 *
 * В регистровом IR массивов как типа нет: всё уходит в хост-вызов (`система.массив.*`), а эмиттер
 * оболочки делает из него носитель `IR.invoke`. Пока такие вызовы не заменены настоящими `ldd`/`std`,
 * ядро FIR не собирается: 22 вызова из 111 инструкций (`docs/e2k-opcodes-real.md` §7).
 *
 * # Соглашение (НАШЕ решение, не из источника)
 *
 * Массив — указатель на блок `[длина:8][элемент0:8][элемент1:8]…`. Почему так: адрес в e2k —
 * **сумма двух регистров** (`qemu/target/e2k/tcg/translate-al-c11.c:26-34`), поля смещения в
 * команде нет, поэтому длина должна лежать рядом с элементами и находиться по тому же указателю.
 *
 * | регистр | что держит | кто пишет |
 * |---|---|---|
 * | `%b[62]` | указатель кучи (растёт вверх по 8 байт на массив) | пролог и `создать` |
 * | `%b[61]` | 8 — размер элемента и заголовка | пролог |
 * | `%b[60]` | 0 — нулевое смещение адреса | пролог |
 * | `%b[59]`, `%b[58]` | временные | рантайм (портит) |
 *
 * Чужой код в эти регистры не пишет: операция массива, у которой операнд попал в зарезервированную
 * область, **отказывает** ({@link RESERVED_FROM} и ниже) — иначе она затрёт указатель кучи.
 *
 * # Умножение на 8 — удвоением, а не `shls`
 *
 * `shls` есть в таблице МЦСТ (ALOPF1, `0x18`, `opcodes/e2k-opc.h:139`), но **не проверен прогоном**;
 * `adds` проверен (`src/e2k/e2kWideQemu.test.ts`). Выбор в пользу проверенного: три `adds` дают ×8.
 *
 * # Чего рантайм НЕ делает
 *
 * - **границы не проверяются**: в модели `получить` вне границ даёт `null`
 *   (`src/runtime/vm/interpreter.ts:70`), наш `ldd` прочитает соседнюю память. Для ядер DSP индексы
 *   в границах по построению; проверка границ требует сравнения и ветвления — отдельная работа.
 * - `установить`, `удалить`, `срез`, строки, математика — **отказ с причиной**.
 */

import type { AsmInstruction, Operand } from './backend';

const reg = (index: number): Operand => ({ kind: 'reg', index });

/**
 * Зарезервированные регистры рантайма.
 *
 * `scratch` и `scratch2` рантайм **портит** — это часть контракта, а не случайность.
 */
export const ARRAY_REGISTERS = {
  /**
   * Регистры взяты с **верхнего края окна**, и это вынужденно: `%b[N]` существует только внутри
   * текущего окна (`qemu/target/e2k/reg-index.h:55-81`), а модель при `rsz = 7` даёт всего
   * `%b[0..15]` — измерено (`.tmp/rsz-sweep.ts`). Поэтому территория рантайма — `%b[10..15]`;
   * код, которому этого мало, получает **отказ**, а не тихую порчу указателя кучи.
   */
  /** Ноль: нулевое смещение адреса (`ldd база, ноль, приёмник`). */
  zero: 12,
  /** Единица: длина растёт **на элемент**, а «+1» из ниоткуда не берётся. */
  one: 13,
  /** Восемь: размер элемента и слова заголовка. */
  eight: 14,
  /** Указатель кучи: растёт вверх по 8 байт на массив. */
  heap: 15,
  /** Временный (`×8` и адрес элемента) — рантайм **портит**. */
  scratch: 11,
  /** Второй временный (новая длина и адрес записи) — рантайм **портит**. */
  scratch2: 10,
} as const;

/**
 * Размер окна (`setbn rsz`), при котором верхние регистры рантайма **адресуемы**.
 *
 * `%b[N]` существует только внутри текущего окна: индекс переводится в физический регистр как
 * `(wd_base_d + idx) % MAXSR_D`, а выход за `size_d` — исключение `exc_window_bounds`
 * (`qemu/target/e2k/reg-index.h:55-81`). Измерено (`.tmp/rsz-sweep.ts`): при `rsz = 5` доступны
 * `%b[0..11]`, при `rsz = 6` — `%b[0..13]`, при `rsz = 7` — `%b[0..15]`, а `rsz ≥ 8` не работает
 * вовсе (начальные `psize_q = 4`, `size_q = 8` квадрослов — `qemu/linux-user/e2k/cpu_loop.c:302-303`
 * — дают не больше 16 единиц).
 */
export const ARRAY_WINDOW_RSZ = 7;

/** С какого номера регистры заняты рантаймом: чужой операнд отсюда — отказ. */
export const RESERVED_FROM = 10;

/** Вызовы, которые рантайм умеет заменять настоящими обращениями к памяти. */
export const SUPPORTED_ARRAY_CALLS: readonly string[] = [
  'система.массив.создать',
  'система.массив.длина',
  'система.массив.получить',
  'система.массив.добавить',
];

/** Отказ рантайма массивов: причина называется, а не замалчивается. */
export class ArrayRuntimeRefusal extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ArrayRuntimeRefusal';
  }
}

/** Арность вызова по источнику: `src/runtime/vm/invokeRegistry.ts:44-50`. */
const ARITY: Readonly<Record<string, number>> = {
  'система.массив.создать': 0,
  'система.массив.длина': 1,
  'система.массив.получить': 2,
  'система.массив.добавить': 2,
};

/** Проверить, что операнд не попал в зарезервированную область. */
function checkOperand(operand: Operand, name: string, role: string): void {
  if (operand.kind !== 'reg') {
    throw new ArrayRuntimeRefusal(`«${name}»: ${role} обязан быть регистром, а не ${operand.kind}`);
  }
  if (operand.index >= RESERVED_FROM) {
    throw new ArrayRuntimeRefusal(
      `«${name}»: регистр %b[${operand.index}] зарезервирован рантаймом массивов (с %b[${RESERVED_FROM}] ` +
        'и выше: куча, размер элемента, ноль и временные — src/e2k/arrayRuntime.ts); ' +
        'операция зарезервировала бы их',
    );
  }
}

/** `adds src1, src2, dst` — форма ALF1: адрес/арифметика (`opcodes/e2k-opc.h:19`). */
const adds = (src1: number, src2: number, dst: number): AsmInstruction => ({
  mnemonic: 'adds',
  channel: 0,
  operands: [reg(src1), reg(src2), reg(dst)],
});

/** `ldd база, смещение, приёмник` — адрес = база + смещение (`translate-al-c11.c:30-34`). */
const ldd = (src1: number, src2: number, dst: number): AsmInstruction => ({
  mnemonic: 'ldd',
  channel: 0,
  operands: [reg(src1), reg(src2), reg(dst)],
});

/**
 * `std значение, база, смещение` — порядок операндов **текстовый** (измерено): у ассемблера текст
 * идёт `(значение, база, смещение)` = `(src3, src1, src2)` (`.tmp/std-order.ts`).
 */
const std = (value: number, src1: number, src2: number): AsmInstruction => ({
  mnemonic: 'std',
  channel: 2, // `st*` разрешены только в каналах 2 и 5 (opcodes/e2k-opc.h:969-984)
  operands: [reg(value), reg(src1), reg(src2)],
});

/**
 * `×8` удвоением: три `adds` (проверенная форма), результат — в `dst`.
 * Требует, чтобы `src` и `dst` были разными регистрами (иначе первое удвоение затрёт вход).
 */
function timesEight(src: number, dst: number): AsmInstruction[] {
  return [adds(src, src, dst), adds(dst, dst, dst), adds(dst, dst, dst)];
}

/**
 * Понизить вызов массива в настоящие команды e2k.
 *
 * @param name имя хост-вызова (`система.массив.*`) — семантику несёт имя, а не код операции
 * @param args регистры аргументов в порядке вызова
 * @param dst регистр приёмника (у `добавить` результата нет — `undefined`)
 */
export function lowerArrayCall(name: string, args: readonly Operand[], dst: number | undefined): AsmInstruction[] {
  const arity = ARITY[name];
  if (arity === undefined) {
    throw new ArrayRuntimeRefusal(
      `«${name}»: у рантайма массивов нет такой операции — он умеет ${SUPPORTED_ARRAY_CALLS.join(', ')}; ` +
        'остальное (установить, удалить, срез, строки, математика) не заменено настоящими обращениями',
    );
  }
  if (args.length !== arity) {
    throw new ArrayRuntimeRefusal(`«${name}»: аргументов ${args.length}, по источнику ${arity} (invokeRegistry.ts:44-50)`);
  }
  args.forEach((operand, index) => checkOperand(operand, name, `аргумент ${index}`));
  const registers = args.map((operand) => (operand as { index: number }).index);
  const { zero, one, eight, heap, scratch, scratch2 } = ARRAY_REGISTERS;

  if (dst !== undefined && dst >= RESERVED_FROM) {
    throw new ArrayRuntimeRefusal(
      `«${name}»: приёмник %b[${dst}] зарезервирован рантаймом массивов (с %b[${RESERVED_FROM}])`,
    );
  }

  switch (name) {
    case 'система.массив.длина':
      // Длина лежит в первом слове блока: адрес = массив + 0.
      return [ldd(registers[0]!, zero, dst!)];
    case 'система.массив.создать':
      // Указатель кучи — в приёмник, длина = 0, куча сдвинута на слово заголовка.
      return [adds(heap, zero, dst!), std(zero, dst!, zero), adds(heap, eight, heap)];
    case 'система.массив.получить': {
      // Адрес элемента = массив + 8 + индекс*8.
      const steps = timesEight(registers[1]!, scratch);
      return [
        ...steps,
        adds(scratch, eight, scratch),
        adds(scratch, registers[0]!, scratch),
        ldd(scratch, zero, dst!),
      ];
    }
    case 'система.массив.добавить': {
      // Длина обновляется ДО вычисления адреса (иначе адрес считался бы по новой длине),
      // но адрес считается по СТАРОЙ длине — она остаётся в scratch.
      const steps = timesEight(scratch, scratch2);
      return [
        ldd(registers[0]!, zero, scratch),
        adds(scratch, one, scratch2),
        std(scratch2, registers[0]!, zero),
        ...steps.map((instruction) => instruction),
        adds(scratch2, eight, scratch2),
        adds(scratch2, registers[0]!, scratch2),
        std(registers[1]!, scratch2, zero),
      ];
    }
    default:
      throw new ArrayRuntimeRefusal(`«${name}»: ветвь не описана`);
  }
}

/**
 * Пролог: ноль, размер элемента и указатель кучи.
 *
 * Куча — **внешняя память** (адрес 64-битным литералом, форма 0xdc), а не литерал в команде: она
 * должна быть записываемой и лежать **не в странице кода** — запись в страницу кода кончается
 * `QEMU internal SIGSEGV {code=ACCERR}` (измерено, `src/e2k/e2kMemoryQemu.test.ts`).
 */
export function arrayPrologue(heapAddress: number): AsmInstruction[] {
  if (!Number.isInteger(heapAddress) || heapAddress < 0) {
    throw new ArrayRuntimeRefusal(`адрес кучи обязан быть неотрицательным целым, получено ${String(heapAddress)}`);
  }
  const { zero, one, eight, heap } = ARRAY_REGISTERS;
  return [
    // Окно расширено ДО первого обращения к верхним регистрам: без этого `%b[10..15]`
    // не адресуются (измерено, `.tmp/rsz-sweep.ts`).
    {
      mnemonic: 'setbn',
      channel: 0,
      operands: [{ kind: 'imm', value: ARRAY_WINDOW_RSZ }, { kind: 'imm', value: 0 }, { kind: 'imm', value: 0 }],
    },
    { mnemonic: 'movts', channel: 0, operands: [{ kind: 'imm', value: 0 }, reg(zero)] },
    { mnemonic: 'movts', channel: 0, operands: [{ kind: 'imm', value: 1 }, reg(one)] },
    { mnemonic: 'movts', channel: 0, operands: [{ kind: 'imm', value: 8 }, reg(eight)] },
    { mnemonic: 'movtd', channel: 0, operands: [{ kind: 'imm64', value: BigInt(heapAddress) } as Operand, reg(heap)] },
  ];
}

/**
 * Сторож последовательности: проверяет **смысл** шагов, а не их наличие.
 *
 * Зачем: оракул сравнивает последовательность с ожидаемой, а сторож ловит дефект, если ожидание
 * подменили вместе с реализацией. Он же — материал негативного контроля (снятый сдвиг кучи,
 * потерянная запись длины).
 */
export function checkArraySequence(name: string, instructions: readonly AsmInstruction[]): string[] {
  const problems: string[] = [];
  const kinds = instructions.map((instruction) => instruction.mnemonic);
  switch (name) {
    case 'система.массив.создать': {
      if (!kinds.includes('std')) problems.push('«создать»: длина массива не обнулена (нет записи)');
      // Указатель кучи обязан сдвинуться: иначе два массива лягут на один адрес.
      const advancesHeap = instructions.some(
        (instruction) =>
          instruction.mnemonic === 'adds' &&
          instruction.operands.some((operand) => operand.kind === 'reg' && operand.index === ARRAY_REGISTERS.heap) &&
          instruction.operands[2]?.kind === 'reg' &&
          (instruction.operands[2] as { index: number }).index === ARRAY_REGISTERS.heap,
      );
      if (!advancesHeap) problems.push('«создать»: указатель кучи не сдвинут — массивы наложатся друг на друга');
      break;
    }
    case 'система.массив.добавить': {
      if (!kinds.includes('ldd')) problems.push('«добавить»: длина не прочитана');
      if (kinds.filter((kind) => kind === 'std').length < 2) {
        problems.push('«добавить»: длина не записана или значение не записано — нужны обе записи');
      }
      if (kinds.filter((kind) => kind === 'adds').length < 5) {
        problems.push('«добавить»: адрес элемента не досчитан (нужны ×8, заголовок и база)');
      }
      break;
    }
    case 'система.массив.получить': {
      if (kinds.filter((kind) => kind === 'adds').length < 5) {
        problems.push('«получить»: адрес элемента не досчитан (нужны ×8, заголовок и база)');
      }
      if (kinds.at(-1) !== 'ldd') problems.push('«получить»: последним шагом должно быть чтение');
      break;
    }
    case 'система.массив.длина': {
      if (kinds.length !== 1 || kinds[0] !== 'ldd') problems.push('«длина»: это одно чтение слова длины');
      break;
    }
    default:
      problems.push(`«${name}»: сторож для этой операции не описан`);
  }
  return problems;
}
