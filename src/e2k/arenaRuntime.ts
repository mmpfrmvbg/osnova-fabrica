/**
 * АРЕНА КАК ОПЕРАЦИЯ ЯЗЫКА: `система.память.выделить(байт)` НА ЦЕЛИ.
 *
 * # Что здесь, а чего нет
 *
 * | что | где живёт |
 * |---|---|
 * | носители и их команды (заведение, выделение, чтение) | `src/e2k/procedureCall.ts` |
 * | **расширение операции языка в носители**: сайт, проверка предела, блок отказа | здесь |
 *
 * Проверка живёт **внутри понижения операции**, а не в программе: программа, забывшая проверить
 * предел, всё равно получает названный отказ, а не тихую порчу памяти за ареной.
 *
 * # Почему регистры состояния — `%b[4]` (указатель) и `%b[6]` (предел)
 *
 * Регистр арены обязан пережить **и печать, и вложенный вызов** — приёмка требует обоих. Разбор по
 * числам (все — замеры дерева):
 *
 * | кто | какие регистры трогает | следствие |
 * |---|---|---|
 * | вложенный вызов (`wbs = 4`) | окно вызываемой = `%b[8..23]`; её пул — `%r0..%r9` = `%b[8..17]` | `%b[0..7]` **переживают вызов**, `%b[8..15]` — нет |
 * | печать числа | `PRINT_PRIMITIVE_CLOBBERS` = `%b[0..11]` целиком | любой регистр ниже 12 обязан быть **сохранён сайтом печати** |
 * | рантайм массивов | `%b[10..15]` | ниже 10 — не его |
 * | банк `%b[16..31]` | требует роста окна точки входа (32/31) и `wbs = 16` | отдельная работа: точка входа сегодня **не растёт** |
 *
 * Отсюда выбор: пара `%b[4]` (указатель) и `%b[6]` (предел) — ниже восьми (переживают вызов) и
 * **объявлены живыми** для раскладки, поэтому сайт печати сохраняет их ровно так же, как сохраняет
 * накопитель в записи `43` (измерено). `%b[5]` — только ключ предиката сравнения (значения в нём не
 * бывает: предикат — файл предикатов, `pairPredicates`), но он объявлен зарезервированным, чтобы
 * раскладка не положила туда чужое.
 *
 * # Почему сравнение читает физические регистры, а не носители чтения
 *
 * Носители `IR.arena_pointer`/`IR.arena_limit` (`procedureCall.ts`) заведены, когда сравнение жило
 * **до раскладки**: тогда физические регистры арены языку носителей не видны (§3.75.2). Расширение
 * здесь идёт **после** раскладки — там номера регистров уже физические, и `IR.spill_ld`/`IR.spill_st`
 * (`src/vliw/spill.ts`) устроены ровно так же. Поэтому сайт читает указатель и предел **прямо**, а
 * форма команды сравнения — та же, что у пар корпуса.
 *
 * # Порядок проверки и точная граница
 *
 * Полоса арены — `[base, limit)`, ровно заполнить её можно. Поэтому отказ наступает при
 * `новый указатель > предел` (строго), а не `≥`: условие пишется **как есть** и переход идёт с
 * **отрицанием** предиката — эталон корпуса (`docs/hardware-debt.md` §3.80.1: `cmplesb` + `? ~%pred0`).
 */

import type { AsmInstruction, Operand } from './backend';
import { MINIMAL_BASE } from './elfMinimal';
import { ARRAY_WINDOW_RSZ } from './arrayRuntime';
import {
  ARENA_ALLOC_CARRIER,
  ARENA_INIT_CARRIER,
  ARENA_LIMIT_BASE,
  ARENA_LIMIT_CARRIER,
  ARENA_POINTER_BASE,
  ARENA_POINTER_CARRIER,
  arenaAllocImmediateInstructions,
  arenaAllocRegisterInstructions,
  arenaInitInstructions,
  arenaLimitInstructions,
  arenaPointerInstructions,
} from './procedureCall';
import { syscallFrameOfCarrier } from './printCall';
import { STRING_ARENA_CONCAT_CARRIER, STRING_ARENA_COPY_CARRIER } from './stringRuntime';
import {
  ENTRY_SYSCALL_FRAME,
  SYS_EXIT,
  SYS_WRITE,
  STDERR_FD,
  syscallWindowOf,
  type SyscallFrame,
} from './syscallRuntime';

const imm = (value: number): Operand => ({ kind: 'imm', value });
const reg = (index: number): Operand => ({ kind: 'reg', index });
const window_ = (index: number): Operand => ({ kind: 'reg', index, file: 'window' });
const f64 = (value: number): Operand => ({ kind: 'imm64', value: BigInt(value) }) as unknown as Operand;
const a = (mnemonic: string, operands: readonly Operand[], channel = 0): AsmInstruction => ({
  mnemonic,
  channel,
  operands,
});

/** Имя операции языка, которую расширяет этот модуль. */
export const ARENA_CALL = 'система.память.выделить';

/**
 * АРЕНА: адреса и размер — решение lead от 2026-09-29 (`docs/hardware-debt.md` §3.88.4).
 *
 * `0x102000` — сразу за отображёнными восемью килобайтами и выше площадки печати (`0x101f00`).
 * 4096 байт, а не 256 (зазор): «256 — граница, а не бюджет» — программа чуть больше упрётся
 * немедленно.
 *
 * **Граница, названная здесь:** куча рантайма массивов начинается там же — `HEAP_OFFSET = 0x2000`,
 * то есть `0x102000`, и растёт вверх. Программа, которой нужны **и массивы, и арена**, в одной
 * редакции не разведена: это названный отказ раскладки (`src/e2k/programImage.ts`), а не надежда.
 */
export const ARENA_BASE = MINIMAL_BASE + 0x2000;
export const ARENA_BYTES = 0x1000;
export const ARENA_LIMIT = ARENA_BASE + ARENA_BYTES;

/**
 * Отображённая память образа: `p_memsz` = размер файла + `extraMemory`.
 *
 * `extraMemory` пишет **только** `p_memsz` (`src/e2k/elfMinimal.ts#buildElfFromCode`), кода не
 * касается — поэтому арена не двигает ни одного закреплённого числа.
 */
export const ARENA_EXTRA_MEMORY = 0x3000;

/** Ключ предиката сравнения: значения в нём не бывает, но раскладка не должна его отдавать. */
export const ARENA_FLAG_REGISTER = 5;

/**
 * Регистры, которые раскладка не имеет права отдать, когда образ пользуется ареной.
 *
 * ФУНКЦИЯ, а не константа: номера берутся у `procedureCall` (там живут сами команды), а этот модуль
 * входит с ним в кольцо импортов (`procedureCall` → `twoPassLayout` → сюда). Читать их на загрузке
 * модуля нельзя — `ARENA_POINTER_BASE` окажется ещё не определён (проверено: падение на импорте).
 */
export function arenaReservedRegisters(): readonly number[] {
  return [ARENA_POINTER_BASE, ARENA_FLAG_REGISTER, ARENA_LIMIT_BASE];
}

/** Строка отказа — ДОСЛОВНО контракт исчерпания (`docs/hardware-debt.md` §3.74.2). */
export const ARENA_REFUSAL_TEXT = 'арена исчерпана: выделение сверх предела';
/** Код возврата отказа (наблюдаем: канал 8-битный, 231 < 256). */
export const ARENA_REFUSAL_CODE = 231;
/** Носитель блока отказа: вывод строки в stderr и выход с кодом. */
export const ARENA_REFUSAL_CARRIER = 'IR.arena_refusal';
/** Ключ статического блоба строки отказа (`src/e2k/stringPlan.ts`). */
export const ARENA_REFUSAL_BLOB_KEY = '⟨текст отказа арены⟩';

/** Пользуется ли образ ареной: по имени вызова в потоке носителей. */
export function usesArena(code: readonly AsmInstruction[], invokeNames: readonly string[]): boolean {
  return code.some((carrier) => {
    if (carrier.mnemonic !== 'IR.invoke') return false;
    const payload = carrier.operands[3];
    return payload !== undefined && payload.kind === 'imm' && invokeNames[payload.value] === ARENA_CALL;
  });
}

/**
 * САЙТ ВЫДЕЛЕНИЯ: три носителя, и каждый — существующий.
 *
 * | носитель | что делает |
 * |---|---|
 * | `IR.arena_alloc [размер, приёмник]` | приёмник ← старый указатель; указатель += размер |
 * | `IR.le [ключ, указатель, предел]` | «новый указатель ≤ предела» — условие **как есть** |
 * | `IR.jmp_if_not [ключ, отказ]` | переход с **отрицанием** предиката (§3.80.1) |
 *
 * @param size регистр IR с размером выделения (язык знает его только в рантайме)
 * @param destination регистр-приёмник результата операции
 * @param refusalIndex индекс носителя, с которого начинается блок отказа
 */
export function arenaSiteCarriers(
  size: Operand,
  destination: Operand,
  refusalIndex: number,
): AsmInstruction[] {
  return [
    { mnemonic: ARENA_ALLOC_CARRIER, channel: 0, operands: [size, destination] },
    { mnemonic: 'IR.le', channel: 0, operands: [reg(ARENA_FLAG_REGISTER), reg(ARENA_POINTER_BASE), reg(ARENA_LIMIT_BASE)] },
    { mnemonic: 'IR.jmp_if_not', channel: 0, operands: [reg(ARENA_FLAG_REGISTER), imm(refusalIndex)] },
  ];
}

/** Заведение арены: один носитель на программу (в прологе образа). */
export function arenaInitCarrier(): AsmInstruction {
  return { mnemonic: ARENA_INIT_CARRIER, channel: 0, operands: [imm(ARENA_BASE), imm(ARENA_LIMIT)] };
}

/** Блок отказа: два носителя, которые никто не проходит насквозь (после выхода управления нет). */
export function arenaRefusalCarriers(address: number, byteLength: number): AsmInstruction[] {
  return [
    { mnemonic: ARENA_REFUSAL_CARRIER, channel: 0, operands: [imm(address), imm(byteLength)] },
    { mnemonic: 'IR.exit', channel: 0, operands: [imm(ARENA_REFUSAL_CODE)] },
  ];
}

/**
 * Команды блока отказа: строка в **stderr** (`STDERR_FD = 2`) и `exit(231)`.
 *
 * Строка — статический блоб (его планирует `stringPlan`), поэтому адрес приходит числом: `movtd`
 * несёт 64-битный литерал, `movts` такой константы не несёт (измерено, §3.40).
 *
 * Порядок — как у «hello» и у хвоста печати: `setbn` (окно вращаемых регистров) → аргументы →
 * `sdisp` (тег `CTPSL`) → `call`. Аргументы идут в **оконные** регистры кадра.
 */
export function arenaRefusalInstructions(
  address: number,
  byteLength: number,
  frame: SyscallFrame = ENTRY_SYSCALL_FRAME,
): AsmInstruction[] {
  return [
    ...(frame.setbn ? [a('setbn', [imm(ARRAY_WINDOW_RSZ), imm(0), imm(0)])] : []),
    a('movts', [imm(SYS_WRITE), window_(syscallWindowOf(frame, 0))]),
    a('movts', [imm(STDERR_FD), window_(syscallWindowOf(frame, 1))]),
    a('movtd', [f64(address), window_(syscallWindowOf(frame, 2))]),
    a('movts', [imm(byteLength), window_(syscallWindowOf(frame, 3))]),
    a('sdisp', [imm(1), imm(0)]),
    a('call', [imm(1), imm(frame.wbs)]),
    a('movts', [imm(SYS_EXIT), window_(syscallWindowOf(frame, 0))]),
    a('movts', [imm(ARENA_REFUSAL_CODE), window_(syscallWindowOf(frame, 1))]),
    a('sdisp', [imm(1), imm(0)]),
    a('call', [imm(1), imm(frame.wbs)]),
  ];
}

/** Команды заведения арены — тот же источник, что у носителя (разойтись нечем). */
export function arenaPrologueInstructions(): AsmInstruction[] {
  return arenaInitInstructions(ARENA_BASE, ARENA_LIMIT);
}

/** Команды выделения — тот же источник, что у носителя. */
export function arenaSiteInstructions(size: number, destination: number): AsmInstruction[] {
  return arenaAllocRegisterInstructions(size, destination);
}

/** Носитель ли это арены — по имени: раскладке нужен один признак, а не пять сравнений. */
export function isArenaCarrier(carrier: AsmInstruction): boolean {
  return (
    carrier.mnemonic === ARENA_INIT_CARRIER ||
    carrier.mnemonic === ARENA_ALLOC_CARRIER ||
    carrier.mnemonic === ARENA_POINTER_CARRIER ||
    carrier.mnemonic === ARENA_LIMIT_CARRIER ||
    carrier.mnemonic === ARENA_REFUSAL_CARRIER
  );
}

/**
 * КОМАНДЫ НОСИТЕЛЯ АРЕНЫ — ОДИН ИСТОЧНИК И ДЛЯ ПОНИЖЕНИЯ, И ДЛЯ ФОРМЫ.
 *
 * Раскладка обязана видеть ровно те байты, которые выпустит понижение: разойдись они — уедут адреса
 * переходов и вызовов (класс `docs/hardware-debt.md` §3.35). `twoPassLayout` берёт форму отсюда же,
 * а не из своей таблицы длин.
 *
 * `undefined` — операнды носителя не той формы; причина называется в понижении.
 */
export function arenaCarrierInstructions(carrier: AsmInstruction): AsmInstruction[] | undefined {
  const operands = carrier.operands;
  switch (carrier.mnemonic) {
    case ARENA_INIT_CARRIER: {
      const base = operands[0];
      const limit = operands[1];
      if (base === undefined || base.kind !== 'imm' || limit === undefined || limit.kind !== 'imm') return undefined;
      return arenaInitInstructions(base.value, limit.value);
    }
    case ARENA_ALLOC_CARRIER: {
      const size = operands[0];
      const destination = operands[1];
      if (destination === undefined || destination.kind !== 'reg') return undefined;
      // Размер приходит ЛИБО регистром (язык знает его в рантайме), ЛИБО числом (склейка строк:
      // её длины статические). Обе редакции — в `src/e2k/procedureCall.ts`, и обе дают одну форму
      // `adds`, поэтому раскладке нечем разойтись с понижением.
      if (size === undefined) return undefined;
      if (size.kind === 'reg') return arenaAllocRegisterInstructions(size.index, destination.index);
      if (size.kind === 'imm') return arenaAllocImmediateInstructions(size.value, destination.index);
      return undefined;
    }
    case ARENA_POINTER_CARRIER: {
      const destination = operands[0];
      if (destination === undefined || destination.kind !== 'reg') return undefined;
      return arenaPointerInstructions(destination.index);
    }
    case ARENA_LIMIT_CARRIER: {
      const destination = operands[0];
      if (destination === undefined || destination.kind !== 'reg') return undefined;
      return arenaLimitInstructions(destination.index);
    }
    case ARENA_REFUSAL_CARRIER: {
      const address = operands[0];
      const byteLength = operands[1];
      if (address === undefined || address.kind !== 'imm' || byteLength === undefined || byteLength.kind !== 'imm') {
        return undefined;
      }
      return arenaRefusalInstructions(address.value, byteLength.value, syscallFrameOfCarrier(carrier));
    }
    default:
      return undefined;
  }
}

/**
 * ГРУППЫ НОСИТЕЛЕЙ ДЛЯ РАСШИРЕНИЯ: что встаёт вместо чего в потоке после раскладки.
 *
 * Возвращается **картой групп**, а не готовым потоком: индексы и цели переходов пересчитывает
 * `src/e2k/procedureCall.ts#expandCarriers` — второй счётчик индексов разошёлся бы с первым.
 *
 * Заведение арены встаёт **прологом ТОЧКИ ВХОДА** (группа на её первом носителе: сначала заведение,
 * потом сам носитель), сайты — вместо вызовов, блок отказа конвейер дописывает в конец потока.
 *
 * Почему не в начало потока: точка входа может стоять в модуле НЕ первой, и тогда конвейер ставит в
 * начало переход к ней (`src/e2k/procedureCall.ts#prepareImage`) — заведение осталось бы за
 * переходом и не исполнилось бы вовсе. Измерено: указатель и предел читались как мусор, и проверка
 * срабатывала на первом же выделении (`.tmp/arena-loop.elf`, ревизия до этой правки).
 */
export interface ArenaGroups {
  readonly groups: ReadonlyMap<number, readonly AsmInstruction[]>;
  readonly sites: number;
  /** Сколько сайтов СКЛЕЙКИ СТРОК ушло в арену (`IR.arena_concat`) — для отчёта и сторожей. */
  readonly concatSites: number;
  /** Индекс блока отказа в потоке ПОСЛЕ расширения (цели переходов указывают на него). */
  readonly refusalIndex: number;
}

/**
 * САЙТ СКЛЕЙКИ СТРОК В АРЕНЕ: тот же сайт выделения плюс копирование байтов.
 *
 * Проверка предела — **та же** (`arenaSiteCarriers`), а не своя: исчерпание обязано быть одним
 * контрактом с одним текстом и одним кодом, иначе склейка и `система.память.выделить` разошлись бы
 * в том, что считается исчерпанием. Отличается только приёмник: у склейки он же — БАЗА ЗАПИСИ
 * копирования (`IR.string_arena_copy`), потому что адрес блока уже в нём.
 */
function arenaConcatSite(carrier: AsmInstruction, refusalIndex: number): readonly AsmInstruction[] | undefined {
  const first = carrier.operands[0];
  const second = carrier.operands[1];
  const destination = carrier.operands[2];
  const firstBytes = carrier.operands[3];
  const secondBytes = carrier.operands[4];
  if (first === undefined || second === undefined || destination === undefined) return undefined;
  if (first.kind !== 'reg' || second.kind !== 'reg' || destination.kind !== 'reg') return undefined;
  if (firstBytes === undefined || secondBytes === undefined) return undefined;
  if (firstBytes.kind !== 'imm' || secondBytes.kind !== 'imm') return undefined;
  return [
    ...arenaSiteCarriers(imm(firstBytes.value + secondBytes.value), destination, refusalIndex),
    {
      mnemonic: STRING_ARENA_COPY_CARRIER,
      channel: 0,
      operands: [first, second, destination, firstBytes, secondBytes],
    },
  ];
}

/**
 * @param code носители ПОСЛЕ раскладки регистров
 * @param invokeNames таблица имён образа оболочки (семантику несёт имя, а не код операции)
 * @param entryOffset индекс первого носителя ТОЧКИ ВХОДА — её прологом и заводится арена
 */
export function arenaGroups(
  code: readonly AsmInstruction[],
  invokeNames: readonly string[],
  entryOffset: number,
): ArenaGroups {
  const isArenaInvoke = (carrier: AsmInstruction): boolean => {
    if (carrier.mnemonic !== 'IR.invoke') return false;
    const payload = carrier.operands[3];
    return payload !== undefined && payload.kind === 'imm' && invokeNames[payload.value] === ARENA_CALL;
  };
  const isArenaConcat = (carrier: AsmInstruction): boolean => carrier.mnemonic === STRING_ARENA_CONCAT_CARRIER;
  const sites = code.filter(isArenaInvoke).length;
  const concatSites = code.filter(isArenaConcat).length;
  // Индекс блока отказа известен ДО сборки: заведение — один носитель, сайт выделения — три вместо
  // одного (+2), сайт склейки — четыре вместо одного (+3), блок отказа — два в конце.
  const refusalIndex = 1 + code.length + 2 * sites + 3 * concatSites;
  const groups = new Map<number, readonly AsmInstruction[]>();
  code.forEach((carrier, index) => {
    const site = isArenaInvoke(carrier)
      ? ((): readonly AsmInstruction[] | undefined => {
          const size = carrier.operands[1];
          const destination = carrier.operands[4];
          if (size === undefined || size.kind !== 'reg' || destination === undefined || destination.kind !== 'reg') {
            return undefined;
          }
          return arenaSiteCarriers(size, destination, refusalIndex);
        })()
      : undefined;
    const concat = site === undefined && isArenaConcat(carrier) ? arenaConcatSite(carrier, refusalIndex) : undefined;
    // Заведение арены — прологом ТОЧКИ ВХОДА; если её первый носитель сам сайт, порядок сохраняется:
    // заведение, затем сайт.
    const head = index === entryOffset ? [arenaInitCarrier()] : [];
    const body = site ?? concat ?? [carrier];
    if (head.length === 0 && site === undefined && concat === undefined) return;
    groups.set(index, [...head, ...body]);
  });
  // Точки входа нет в потоке (пустой модуль) — заведение всё равно обязано быть: названо, не молча.
  if (!groups.has(entryOffset)) {
    groups.set(entryOffset, [arenaInitCarrier(), ...(code[entryOffset] === undefined ? [] : [code[entryOffset]!])]);
  }
  return { groups, sites, concatSites, refusalIndex };
}
