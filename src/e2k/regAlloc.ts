/**
 * LINEAR SCAN: РАСКЛАДКА VREG'ОВ ПО ФИЗИЧЕСКИМ РЕГИСТРАМ.
 *
 * # Зачем
 *
 * Эмиттер оболочки пишет номер vreg'а прямо в поле регистра, то есть «vreg = `%b[N]`». Для ядра
 * FIR это значит: программа занимает `%b[0..16]`, а `%b[10..15]` держит рантайм массивов
 * (`src/e2k/arrayRuntime.ts`) — они затираются. Раскладка разводит живые значения по **десяти**
 * свободных регистров, а нехватку называет отказом.
 *
 * # Алгоритм (linear scan, без раскраски графа)
 *
 * 1. Интервалы сортируются по началу.
 * 2. Активные интервалы держатся в списке, отсортированном по концу.
 * 3. Пока активен интервал, кончившийся раньше начала текущего, — его регистр освобождается.
 * 4. Если свободных нет — **минимальное вытеснение в память**: самое дешёвое из активных значений
 *    уезжает в слот и освобождает регистр (`src/vliw/spill.ts`). Больше
 *    `MAX_SPILLS_PER_PROCEDURE` вытеснений не делается: тогда **отказ** с числом одновременно живых
 *    и списком конфликтующих vreg'ов.
 *
 * # Какие регистры свободны
 *
 * `%b[0..9]` — 10 штук. `%b[10..15]` зарезервированы рантаймом массивов, `%b[16..31]` недоступны:
 * окно по умолчанию даёт 16 регистров, а расширять его (`setwd`) решено не делать — поведение
 * модели неустойчиво (`docs/e2k-setwd-memory.md`).
 */

import type { AsmInstruction, Operand } from './backend';
import {
  cfgSegmentsOf,
  defUseOf,
  liveIntervalsOf,
  mergeLoopCarriedSegments,
  overlaps,
  type LiveInterval,
} from './liveness';
import { removeCopies } from './copyElim';
import { REMAINDER_SCRATCH_REGISTER, needsRemainderScratch } from './remainderRuntime';
import {
  CALLEE_ARRAY_BLOCK_SIZE,
  ENTRY_ARRAY_BASE,
} from './arrayRuntime';
/**
 * Ширина вызова внутренней процедуры — из соглашения о вызове, а не числом: сторож блока рантайма
 * массивов считает по ней границу «своей» половины кадра (`2 * CALL_WBS`, §3.131).
 *
 * Импорт односторонний (`twoPassLayout` раскладку не зовёт), а сама константа — литерал: тем и
 * отличается от `CALLEE_REGISTERS`, которую собирают из неё и потому держат рядом с ней
 * (`twoPassLayout.ts`, разбор порядка импортов).
 */
import { CALL_WBS } from './twoPassLayout';
import { entryProcedureIndex } from './procedureCall';
import { rematerializeConstants } from './rematerialize';
import { DEFAULT_SPILL_BASE } from './elfMinimal';
import {
  MAX_SPILLS_PER_PROCEDURE,
  chooseSpillVictim,
  siteFeasible,
  spillAddressOf,
  spillCostsOf,
  spillLoadCarrier,
  spillSitesOf,
  spillStoreCarrier,
  type SpillOptions,
  type SpilledValue,
} from '../vliw/spill';

/**
 * Операнды-регистры, которые носитель **действительно** читает или пишет.
 *
 * Нужны потому, что слот регистра в носителе бывает заполнен «на всякий случай»: у `IR.ret` без
 * значения (`imm(0)`) второй операнд всё равно несёт `%b[0]` (измерено на всех пяти ядрах,
 * `.tmp/ret-operands.ts`). Если считать такие слоты значениями, `unmapped` становится непустым
 * **всегда** — и настоящий неотображённый vreg (тот, что читается, но регистра не получил) теряется
 * в этом шуме. Источник истины один и тот же — `defUseOf`, по нему же считается живость.
 */
function namedRegisters(instruction: AsmInstruction): ReadonlySet<number> {
  const { def, use } = defUseOf(instruction);
  return new Set([...def, ...use]);
}

/** Сколько отрезков приходится на каждый vreg: по этой разнице видно, кого соединило слияние. */
function countSegmentsByVreg(segments: readonly LiveInterval[]): ReadonlyMap<number, number> {
  const counts = new Map<number, number>();
  for (const segment of segments) counts.set(segment.vreg, (counts.get(segment.vreg) ?? 0) + 1);
  return counts;
}

/** Свободные регистры раскладки: `%b[0..9]`. */
export const ALLOCATABLE_REGISTERS: readonly number[] = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9];

/**
 * СКОЛЬКО АРГУМЕНТОВ ПРИНИМАЕТ КАЖДАЯ ПРОЦЕДУРА — по носителям `IR.call`, которые её зовут.
 *
 * # Зачем это раскладке
 *
 * Соглашение ABI: `i`-й аргумент вызывающий кладёт в `%r(2*wbs + i)` СВОЕГО окна, то есть в
 * `%b[i]` **вызываемой** (`src/e2k/e2kRealRun.ts`, правило `IR.call`). Значит регистры параметров
 * вызываемой заданы не раскладкой, а вызовом: `%b[0..argc−1]`.
 *
 * # Почему нельзя доверить это `incomingRegisters`
 *
 * `incomingRegisters` называет параметром тот vreg, который **читается и нигде не определяется**.
 * Параметр, которому тело ПРИСВАИВАЕТ значение (накопитель цикла: `н = н − 1`), под это правило не
 * попадает — и раскладка вправе увезти его в любой регистр. Пока бюджет был `%b[0..9]`, линейный
 * обход отдавал такому параметру первый свободный регистр, то есть `%b[0]`, и соглашение держалось
 * СОВПАДЕНИЕМ. Как только бюджет вызываемой сузился до её собственной половины
 * (`CALLEE_REGISTERS`), параметр уехал в `%b[8]` — туда, куда вызывающий его не клал: замер
 * `.tmp/osnova-example47-where.ts` (пример `47-факториал-итерацией`: было «120», стало «1» —
 * цикл не выполнялся ни разу, потому что условие читало пустой регистр).
 *
 * Арность берётся из самих вызовов, а не из имени процедуры и не из числа vreg'ов: другого канала,
 * по которому раскладка узнала бы соглашение, нет.
 */
function argumentCountsOf(instructions: readonly AsmInstruction[]): ReadonlyMap<number, number> {
  const counts = new Map<number, number>();
  for (const instruction of instructions) {
    if (instruction.mnemonic !== 'IR.call') continue;
    const flags = instruction.operands[0];
    // Операнд 3 — индекс вызываемой процедуры в списке процедур (`src/e2k/programImage.ts`:
    // по нему же ищется вызов себя). Операнд 0 — признаки: `(есть приёмник) | (аргументов << 1)`.
    const payload = instruction.operands[3];
    if (flags === undefined || flags.kind !== 'imm') continue;
    if (payload === undefined || payload.kind !== 'imm') continue;
    const argc = flags.value >> 1;
    counts.set(payload.value, Math.max(counts.get(payload.value) ?? 0, argc));
  }
  return counts;
}

/**
 * Регистров окна у **вызывающей** (точка входа) — `%r0..%r15`.
 *
 * Измерено прогоном (`.tmp/rsz-sweep.ts`; перемерено на `size_q = 12` — `.tmp/osnova-us-rsz.ts`):
 * при `setbn rsz = 7` доступны `%b[0..15]`, дальше окно не пускает. Это **не** окно вызывающего от
 * порта: при `size_q = 12` порт даёт вызывающему `2*12 = 24` (§3.36), а 16 — объём области
 * вращаемых регистров, который ставит пролог образа (`setbn rsz = 7`). Связь «16 ≤ 24» проверяет
 * `src/e2k/windowGeometry.ts`.
 */
export const WINDOW_REGISTERS_ENTRY = 16;

/**
 * Регистров окна у **вызываемой** процедуры — `%r0..%r15` при `size_q = 12`.
 *
 * Формула порта: `call %ctpr1, wbs=4` уменьшает `size_q` на `wbs`, а индекс окна считается с
 * проверкой `idx < size_d = 2*size_q` (`qemu/target/e2k/tcg/translate-ct.c`, `e2k_cpu_call`-путь;
 * `reg-index.h:55-81`), поэтому вызываемая получает `2*(size_q − wbs)` регистров. При `size_q = 12`
 * и `wbs = 4` это **шестнадцать** — измерено пробой-порогом (`.tmp/osnova-window-ladder.ts`,
 * §3.36) и перепроверено на пересобранной модели (§3.49).
 *
 * История: при `size_q = 8` здесь стояло 8, и процедура, которой нужно больше восьми регистров,
 * **не могла быть вызвана** — `фильтр` ядра FIR занимает десять (`%b[0..9]`). Числа этого не
 * меняют: раскладка по-прежнему выдаёт `%b[0..9]`, а окно решает лишь, можно ли вызвать.
 * Связь «паспорт ↔ эта константа ↔ живая сборка» держит `src/e2k/windowGeometry.ts`.
 */
export const WINDOW_REGISTERS_CALLEE = 16;

/**
 * Занятые регистры — рантайм массивов (`ARRAY_REGISTERS` в `src/e2k/arrayRuntime.ts`):
 * `%b[10..15]`. Проверяются оракулом: раскладка не имеет права их выдать.
 */
export const RESERVED_REGISTERS: readonly number[] = [10, 11, 12, 13, 14, 15];

/** Раскладка: vreg → физический регистр. */
export interface Allocation {
  readonly assignment: ReadonlyMap<number, number>;
  /** Сколько регистров реально занято. */
  readonly used: readonly number[];
}

/** Итог раскладки: либо она есть, либо отказ с причиной. */
export type AllocationResult =
  | { readonly ok: true; readonly allocation: Allocation }
  | {
      readonly ok: false;
      /** Причина с числом одновременно живых интервалов. */
      readonly reason: string;
      /** Какие именно vreg'ы не влезли (конфликтующие в тесный момент). */
      readonly conflicts: readonly number[];
    };

/**
 * Разложить интервалы по свободным регистрам.
 *
 * @param intervals интервалы жизни (из `liveIntervalsOf`)
 * @param free свободные регистры; по умолчанию `%b[0..9]`
 * @param precisePeak точная нижняя граница (максимум живых на выходе, `Liveness.peakLive`) — она
 *   попадает в причину отказа: без неё отказ выглядит как «не хватило по модели раскладки», а с ней
 *   видно, сколько регистров нужно **по существу** (меньше этого числа не обойтись и с разбиением
 *   интервалов).
 */
export function allocateRegisters(
  intervals: readonly LiveInterval[],
  free: readonly number[] = ALLOCATABLE_REGISTERS,
  precisePeak?: number,
): AllocationResult {
  if (free.length === 0) {
    return { ok: false, reason: 'свободных регистров не передано — раскладывать некуда', conflicts: [] };
  }
  const sorted = [...intervals].sort((a, b) => a.start - b.start || a.end - b.end || a.vreg - b.vreg);
  const assignment = new Map<number, number>();
  /** Активные: [конец интервала, регистр, vreg] — отсортированы по концу. */
  const active: { end: number; register: number; vreg: number }[] = [];
  const usedRegisters = new Set<number>();

  for (const interval of sorted) {
    // Освобождаем всё, что кончилось ДО начала текущего. Соприкосновение (end === start) не
    // освобождает: на одной команде чтение и запись не должны попасть в один регистр.
    for (let index = active.length - 1; index >= 0; index--) {
      if (active[index]!.end < interval.start) {
        // Освобождение регистра НЕ вычёркивает его из `usedRegisters`: это множество — «сколько
        // регистров раскладка взяла из файла», а не «сколько занято в последний момент». Прежняя
        // редакция вычёркивала, и «занято» означало «занято последним интервалом» (реестр
        // проверяемости, случай 18).
        active.splice(index, 1);
      }
    }
    const taken = new Set(active.map((entry) => entry.register));
    const register = free.find((candidate) => !taken.has(candidate));
    if (register === undefined) {
      // Конфликтующие — те, с кем текущий интервал пересекается по времени жизни: им нужен другой
      // регистр. Пересекающихся может быть БОЛЬШЕ пика (они не обязаны жить все сразу), поэтому в
      // причине называются оба числа — иначе отказ выглядел бы страшнее, чем он есть.
      const interferes = sorted.filter((other) => other !== interval && overlaps(other, interval));
      const liveAtFailure = interferes.filter((other) => other.start <= interval.start && interval.start <= other.end);
      return {
        ok: false,
        reason:
          `раскладка невозможна: пик одновременной жизни ${peakOf(sorted)}, свободных регистров ${free.length} ` +
          `(${free.map((value) => `%b[${value}]`).join(', ')}); в тесный момент живы ${liveAtFailure.length + 1} ` +
          `интервалов (v${interval.vreg} и ещё ${interferes.length} пересекающихся)` +
          (precisePeak === undefined ? '' : `; точная нижняя граница по живым на выходе: ${precisePeak} регистров`) +
          '; вытеснение в память (spill) здесь не делается — это следующий слой',
        conflicts: [...new Set([interval.vreg, ...interferes.map((other) => other.vreg)])].sort((a, b) => a - b),
      };
    }
    assignment.set(interval.vreg, register);
    active.push({ end: interval.end, register, vreg: interval.vreg });
    active.sort((a, b) => a.end - b.end);
    usedRegisters.add(register);
  }

  return { ok: true, allocation: { assignment, used: [...usedRegisters].sort((a, b) => a - b) } };
}

/** Пик одновременной жизни по интервалам. */
function peakOf(intervals: readonly LiveInterval[]): number {
  let peak = 0;
  for (const interval of intervals) {
    const live = intervals.filter((other) => other.start <= interval.start && interval.start <= other.end).length;
    if (live > peak) peak = live;
  }
  return peak;
}



/** Позиция цели перехода в операндах носителя (`src/e2k/twoPassLayout.ts:414`). */
const JUMP_TARGET_OPERAND: Readonly<Record<string, number>> = {
  'IR.jmp': 0,
  'IR.jmp_if': 1,
  'IR.jmp_if_not': 1,
};

/**
 * Пересчитать цели переходов после преобразований потока.
 *
 * Цели записаны **абсолютными индексами потока модуля** (измерено, случай 17 реестра проверяемости).
 * Преобразования сдвигают индексы в ОБЕ стороны: устранение копий убирает носители (вниз),
 * материализация констант вставляет (вверх). Поэтому пересчёт идёт по **карте** «старый индекс → новый»,
 * а не по разнице длин.
 *
 * Цель, которая сама оказалась снятой, — отказ: вызывать её нечем (`removeCopies` такие пересылки не
 * снимает: пересылка-цель перехода входит в начала блоков). Здесь это проверяется ещё раз, потому
 * что молча сдвинуть цель на соседнюю команду значило бы поменять программу.
 */
function remapJumpTargets(
  instructions: readonly AsmInstruction[],
  movedTo: ReadonlyMap<number, number>,
): { instructions: readonly AsmInstruction[]; problems: readonly string[] } {
  const problems: string[] = [];
  const remapped = instructions.map((instruction) => {
    const targetAt = JUMP_TARGET_OPERAND[instruction.mnemonic];
    if (targetAt === undefined) return instruction;
    const operand = instruction.operands[targetAt];
    if (operand === undefined || operand.kind !== 'imm' || !Number.isInteger(operand.value)) {
      problems.push(`«${instruction.mnemonic}»: цель перехода не выражена числом`);
      return instruction;
    }
    const moved = movedTo.get(operand.value);
    if (moved === undefined) {
      problems.push(`«${instruction.mnemonic}»: цель перехода #${operand.value} снята устранением копий`);
      return instruction;
    }
    const operands = instruction.operands.map((item, at) => {
      if (at !== targetAt || item.kind !== 'imm') return item;
      return { ...item, value: moved };
    });
    return { ...instruction, operands };
  });
  return { instructions: remapped, problems };
}

/** Что вышло по одной процедуре: раскладка удалась или отказ с причиной. */
export interface ProcedureAllocation {
  readonly procedure: string;
  readonly vregs: number;
  /** Носителей до устранения копий (то, что выдал эмиттер оболочки). */
  readonly carriers: number;
  /** Носителей после устранения копий: столько инструкций раскладывалось. */
  readonly rewritten: number;
  /** Сколько пересылок снято в этой процедуре. */
  readonly removedCopies: number;
  /** Пик модели раскладки по интервалам-объединениям (консервативная величина). */
  readonly peak: number;
  /** Точная нижняя граница: максимум живых на выходе инструкции, обратный анализ с переходами. */
  readonly peakLive: number;
  /** Сколько отрезков жизни было разложено. */
  readonly segments: number;
  /**
   * Входящие vreg'и: читаются, но в этой процедуре не определяются (параметры). Их регистры
   * **закреплены**: перенести значение — значит положить его не туда, куда смотрит вызывающий.
   */
  readonly incoming: readonly number[];
  readonly ok: boolean;
  readonly reason?: string;
  readonly conflicts: readonly number[];
  /**
   * Что уехало в память (минимальное вытеснение, `src/vliw/spill.ts`): значение, слот, адрес и
   * сколько обращений к памяти это добавило. Пусто — вытеснения не потребовалось.
   */
  readonly spilled: readonly SpilledValue[];
  /** Сколько регистров выдано (длина `usedRegisters`). */
  readonly used: number;
  /** Какие именно регистры выданы — по ним проверяется закрепление, и видно, что рантайм не тронут. */
  readonly usedRegisters: readonly number[];
  /**
   * Сколько регистров окна процедура занимает: закреплённые плюс выданные.
   *
   * Это число сравнивается с {@link WINDOW_REGISTERS_CALLEE}: вызываемая процедура получает восемь,
   * и всё, что больше, вызвано быть не может (измерено, `src/e2k/e2kCallWindowQemu.test.ts`).
   */
  readonly windowRegistersNeeded: number;
  /** Влезает ли процедура в окно вызываемой ({@link WINDOW_REGISTERS_CALLEE}). */
  readonly fitsCalleeWindow: boolean;
  readonly unmapped: readonly number[];
}

/** Входящие vreg'и: читаются, но нигде в процедуре не определяются (параметры вызова). */
export function incomingRegisters(instructions: readonly AsmInstruction[]): readonly number[] {  const defined = new Set<number>();
  const used = new Set<number>();
  for (const instruction of instructions) {
    const { def, use } = defUseOf(instruction);
    for (const vreg of def) defined.add(vreg);
    for (const vreg of use) used.add(vreg);
  }
  return [...used].filter((vreg) => !defined.has(vreg)).sort((a, b) => a - b);
}

/**
 * Разложить регистры по процедурам модуля: устранение копий, затем раскладка по **отрезкам** жизни.
 *
 * # Почему отрезки, а не интервалы
 *
 * Интервал-объединение держит регистр за vreg'ом на всём промежутке «первое определение — последнее
 * чтение», включая мёртвые участки. У `фильтр` FIR объединения требуют 11 регистров, отрезки — 9
 * (`docs/e2k-opcodes-real.md` §7.8). Устранение копий обязательно **вместе** с отрезками: без него
 * `фильтр` не влезает в десять регистров даже по отрезкам (замер `.tmp/fit-without-copyelim.ts`).
 *
 * # Что возвращается
 *
 * Переписанный поток **короче** исходного (копии сняты), поэтому смещения процедур меняются — они
 * возвращаются рядом с потоком, а не пересчитываются вызывающим по догадке. Число снятых копий
 * названо отдельно: иначе «инструкций стало меньше» читалось бы как падение покрытия, а не как
 * другой знаменатель.
 *
 * # Отказ
 *
 * Отказ называется (пик, живые в тесный момент, конфликтующие vreg'и), а не замалчивается: номера
 * vreg'ов остаются как есть, и это видно в отчёте. Молчаливое «оставили номера vreg'ов» — это ровно
 * тот случай, когда программа затирает регистры рантайма массивов.
 *
 * **Контрактный поток при отказе ПУСТ (буква D13, исполнена в PHASE-05/TASK-05-01).** Прежде `fail()`
 * клал в результат НЕРАЗЛОЖЕННЫЙ поток процедуры (носители сохраняли регистры, которых раскладка не
 * выдавала) — мусор по построению, из которого можно было собрать образ и «число под отказом»
 * (седьмая тихая ложь). Теперь на отказе `instructions` пуст, а неразложенный поток вместе со
 * смещениями процедур лежит в поле `diagnostic` — диагностика отказа сохранена ЦЕЛИКОМ: причина с
 * именем процедуры и числами (живые против бюджета), перепись носительных отказов, замерные приборы.
 * Сторожа читают диагностический поток ЯВНО и только под отказом (`src/e2k/guards/loweredUnchecked.ts`).
 */
/**
 * ДИАГНОСТИЧЕСКИЙ ПОТОК раскладки (буква D13): неразложенный поток вместе со смещениями процедур —
 * ТОЛЬКО при отказе раскладки. Это НЕ исполняемое и НЕ контрактный поток: носители здесь сохраняют
 * регистры, которых раскладка не выдавала, и собирают их в образ только СТОРОЖИ, глядящие под
 * отказом ЯВНО (`src/e2k/guards/loweredUnchecked.ts`), — чтобы причина отказа и перепись носительных
 * отказов оставались измеримыми. Смещения процедур прилагаются к тому же полю: у потока и его
 * оглавления не может быть разных ревизий.
 */
export interface DiagnosticStream {
  readonly instructions: readonly AsmInstruction[];
  readonly procedures: readonly { readonly name: string; readonly codeOffset: number; readonly vregs: number }[];
}
export function allocateProgram(
  instructions: readonly AsmInstruction[],
  procedures: readonly { readonly name: string; readonly codeOffset: number; readonly vregs: number }[],
  /**
   * План вытеснения. По умолчанию — слоты по конвенции образа ({@link DEFAULT_SPILL_BASE}, под
   * указателем кучи): тогда конвейер, замеры и шлюзовые образы считают **одни и те же** адреса, а
   * не каждый свои. `maxSlots: 0` выключает вытеснение — так проверяется негативный контроль.
   */
  options: {
    /**
     * Процедуры, работающие с массивами (`система.массив.*`): им раскладка выдаёт БЛОК РАНТАЙМА
     * (пять клеток) и возвращает базу в `arrayBases` (§3.128).
     *
     * Список приходит снаружи, а не выводится здесь, и это не послабление: имена хост-вызовов живут
     * в таблице образа оболочки (`ShellImage.invokeNames`), которой у раскладки нет — её зовут и
     * напрямую (оракулы). Не передан список — блоков нет, и обращение к массиву в вызываемой
     * отказывает по имени, а не угадывает клетки.
     */
    readonly arrayProcedures?: readonly number[];
    readonly spill?: SpillOptions;
    /**
     * Регистры, которые операция языка держит САМА (в обход потока носителей) — например регистры
     * состояния арены (`src/e2k/arenaRuntime.ts#ARENA_RESERVED_REGISTERS`). Раскладка их не отдаёт.
     *
     * По умолчанию список пуст, и это не «на всякий случай»: закреплённые числа пяти ядер
     * (`docs/hardware-debt.md` §3.34.4) сняты именно при пустом списке.
     */
    readonly reserved?: readonly number[];
    /**
     * Какие регистры МОЖЕТ занимать процедура с этим номером (по умолчанию — {@link ALLOCATABLE_REGISTERS}).
     *
     * Зачем это вообще нужно. `call wbs = 4` сдвигает окно вызываемой на `2*wbs = 8` регистров,
     * поэтому `%b[n]` **вызываемой** — это `%b[n + 8]` **вызывающего**. Значит младшая половина кадра
     * вызываемой (`%b[0..7]`) — ЧУЖАЯ: `%b[0]`, `%b[1]` приходят аргументами, а `%b[2..7]` — это
     * `%b[10..15]` вызывающего, то есть **рантайм массивов** (`ARRAY_REGISTERS`). Вызываемая,
     * которой раскладка выдала `%b[2..7]`, затирает чужое состояние молча.
     *
     * Замер (`docs/hardware-debt.md` §3.96, проба `.tmp/osnova-reread-which.ts`): одна и та же
     * арифметика `(а + 1) + б` = 11 на модели, временные регистры вызываемой —
     * `%b[2..4]` → **15**, `%b[4..8]` → **14**, `%b[8..12]` → **11**, `%b[12..15]` → **11**.
     * Разница в точности равна тому, что вызываемая оставила в СВОЁМ `%b[4]`: выход программы
     * считает `код = значение + %b[12]` (`src/e2k/printCall.ts#exitCarrierInstructions`), а
     * `%b[4]` вызываемой — это `%b[12]` вызывающего. Отсюда и «тихая ложь»: программа возвращает
     * не своё значение.
     *
     * Собственные регистры вызываемой — только `%b[8..15]`: их вызывающий адресовать не может
     * (его окно — `%b[0..15]`). Это и есть бюджет вызываемой.
     */
    readonly freeFor?: (procedureIndex: number) => readonly number[] | undefined;
    /**
     * ВЫДАТЬ ВИД ПОТОКА ДЛЯ АНАЛИЗА по каждой процедуре — тот самый поток, по которому считаются живость
     * и отрезки (после снятия копий, размножения констант и пересчёта целей переходов в индексы ЭТОГО
     * потока).
     *
     * Зачем снаружи. Носители записаны в индексах потока МОДУЛЯ, а цели переходов раскладка пересчитывает
     * ВНУТРИ (см. `remapJumpTargets`): сторож, спросивший поток носителей напрямую, спрашивал бы не тот
     * граф — в корпусе **24 примера из 47** снимают хотя бы одну копию. Поэтому сторож доминирования
     * (`src/e2k/domination.ts`, срез 5д) берёт граф ОТСЮДА, а не собирает его вторым способом.
     *
     * На раскладку не влияет вовсе: без флага не собирается ничего, с флагом — только ссылки на уже
     * построенные потоки.
     */
    readonly collectAnalysis?: boolean;
  } = {},
): {
  readonly instructions: readonly AsmInstruction[];
  readonly procedures: readonly { readonly name: string; readonly codeOffset: number; readonly vregs: number }[];
  readonly report: readonly ProcedureAllocation[];
  readonly removedCopies: number;
  /**
   * Вид потока для анализа по процедурам — пусто, если {@link collectAnalysis} не запрошен.
   */
  readonly analysis: readonly { readonly procedure: string; readonly instructions: readonly AsmInstruction[] }[];
  /** Сколько определений констант размножено (§7.12 docs/e2k-opcodes-real.md). */
  readonly materializedConstants: number;
  /**
   * БАЗА БЛОКА РАНТАЙМА МАССИВОВ по процедурам (§3.128): `undefined` — процедура с массивами не
   * работает (или список `arrayProcedures` не передан). Базу потребляет понижение — поле
   * `arrayBase` контекста носителя; нет базы — обращение к массиву отказывает по имени.
   */
  readonly arrayBases: readonly (number | undefined)[];
  /**
   * ДИАГНОСТИЧЕСКИЙ ПОТОК (буква D13): НЕРАЗЛОЖЕННЫЙ поток и смещения процедур — ТОЛЬКО при отказе
   * раскладки. Это НЕ исполняемые байты и НЕ контрактный поток: носители здесь сохраняют регистры,
   * которых раскладка не выдавала, и собирают их в образ только СТОРОЖИ, глядящие под отказом ЯВНО
   * (`src/e2k/guards/loweredUnchecked.ts`), — чтобы причина отказа и перепись носительных отказов
   * оставались измеримыми. На успешной раскладке поле `undefined`.
   */
  readonly diagnostic: DiagnosticStream | undefined;
} {
  const result: AsmInstruction[] = [];
  const rewrittenProcedures: { name: string; codeOffset: number; vregs: number }[] = [];
  const report: ProcedureAllocation[] = [];
  /** Вид потока для анализа — только по запросу (`collectAnalysis`), см. объявление ручки. */
  const analysis: { procedure: string; instructions: readonly AsmInstruction[] }[] = [];
  // «Старый индекс потока модуля → новый»: по нему пересчитываются цели переходов ПОСЛЕ сборки.
  const movedTo = new Map<number, number>();
  const spillPlan: SpillOptions = options.spill ?? { base: DEFAULT_SPILL_BASE };
  // РЕЗЕРВ ПОД СКРЫТЫЙ РЕГИСТР СЕРИИ. Носителю `IR.rem` нужен временный регистр под частное
  // (`src/e2k/remainderRuntime.ts`), а раскладка о нём не знает: у носителя объявлены только
  // `def = [d]` и `use = [a, b]`. Решение принимается ЗДЕСЬ, а не в конвейере, намеренно: конвейер
  // — не единственный, кто зовёт раскладку (оракулы зовут её напрямую), и «не забыть добавить
  // резерв» был бы контрактом, который забудут молча, — а забытый резерв это не отказ, а порча
  // значения. Резерв УСЛОВНЫЙ: у программы без `IR.rem` он не берётся вовсе, поэтому закреплённые
  // числа пяти ядер (458 / 53 / 511 / 8800, FIR 181) не двигаются.
  const reserved = new Set<number>(options.reserved ?? []);
  if (needsRemainderScratch(instructions)) reserved.add(REMAINDER_SCRATCH_REGISTER);
  const entryAt = procedures.length === 0 ? 0 : entryProcedureIndex(procedures);
  /**
   * БАЗА БЛОКА РАНТАЙМА МАССИВОВ — по процедуре (§3.128).
   *
   * Блок — пять клеток: ноль, единица, восемь и два временных. Прежде они были КОНСТАНТАМИ 10..14 и
   * заполнялись прологом ОБРАЗА, то есть в плоскости точки входа; у вызываемой её обращения идут
   * оконной формой (`%rN`), и те же номера — уже ДРУГИЕ клетки: `eight` там ноль, и адрес элемента
   * уезжает на слово назад (замерено, §3.127: `а[1]` давал элемент[0]). Поэтому базу выдаёт раскладка
   * — она единственная знает, какая процедура чем пользуется.
   *
   * Клетки точки входа (10..14) лежат ВНЕ её пула (`ALLOCATABLE_REGISTERS` = 0..9); клетки вызываемой
   * (17..21) — выше её пула (`CALLEE_REGISTERS` = 8..15) и не задевают слот вызова `%r16`
   * (`src/e2k/procedureCall.ts#INNER_CALL_WBS`). Поэтому бесплатных для значений клеток не отнимается
   * ни у кого, и закреплённые числа пяти ядер не двигаются.
   */
  const arrayProcedures = new Set<number>(options.arrayProcedures ?? []);
  const arrayBases: (number | undefined)[] = procedures.map(() => undefined);
  /**
   * ПЕРВАЯ ПЯТЁРКА СВОБОДНЫХ клеток бюджета процедуры — блок рантайма массивов (§3.128).
   *
   * Только бюджет и только свободные: за его пределами окно процедуры этих клеток НЕ адресует, и
   * обращение встаёт исключением модели (измерено 2026-10-10: клетки 17..21 в плоскости вызываемой —
   * исключение на первом обращении). Клетки значений (`forbidden`) не годятся: пролог значений пишет
   * в блок ноль, единицу и восемь — значение, живущее там, было бы затёрто молча.
   *
   * # Почему список ЗАПРЕЩЁННЫХ, а не «пул минус занятые» (§3.131)
   *
   * Прежняя редакция брала первую свободную пятёрку ПУЛА, и этого мало: у вызываемой младшая половина
   * кадра — ЧУЖАЯ на время её работы только по ОДНОМУ признаку — она младшая. `call wbs = 4` сдвигает
   * окно на `2*wbs = 8`, поэтому клетка `N` вызываемой — это клетка `N + 8` ВЫЗЫВАЮЩЕГО. Замер
   * 2026-10-10 (§3.130 → §3.131): стендовая проба звала раскладку без `freeFor`, блок вызываемой
   * ложился в клетки 3..7 (это `%b[11..15]` вызывающего), её пролог значений писал ЕДИНИЦУ в клетку 12
   * вызывающего — а выход программы считает `код = значение + %b[12]`
   * (`printCall.ts#exitCarrierInstructions`), и ответ уезжал на «+1»: М3 давало 7 вместо 6, М4 —
   * 6 вместо 5, К3 — 8 вместо 7. Адрес был верный; прибавлена была затёртая чужая клетка.
   *
   * Поэтому клетки ниже `ownFrom` (своей половины кадра) не рассматриваются ВООБЩЕ, а не «по
   * остаточному принципу»: пятёрки в своей половине нет — базы нет, и понижение откажет ПО ИМЕНИ
   * (`OSN-LOW-003`), а не отдаст чужие клетки.
   *
   * # Почему не «зарезервировать и вытеснить» — ИЗМЕРЕНО (2026-10-10)
   *
   * Резерв пятёрки в клетках `%b[10..14]` (одно место у всех процедур, пересечение невозможно по
   * построению) был реализован и **провалился замером**: у вызываемой остаётся `8 − 5 = 3` клетки, из
   * них две заняты параметрами (`%b[8]`, `%b[9]`), поэтому на значения остаётся ОДНА, и раскладка
   * встаёт не отказом, а исключением: «в тесный момент живы 32 отрезков, свободных регистров 3,
   * вытеснять больше нечего» — 4 ядра из 5 (`fir`, `fft`, `convolution`, `correlation`; у `iir`
   * `выделение в вызываемой` отказывает раньше). Значит, восьмиклеточной половины кадра вызываемой
   * для блока и рабочего набора DSP-ядра НЕ ХВАТАЕТ структурно, и цена закрытия этого — не в
   * раскладке: нужен более ШИРОКИЙ кадр вызываемой (A1′, §3.125) или блок меньшего размера
   * (временные только на время операции). Оба названы долгом, ни один здесь не сделан.
   */
  const chooseArrayBlock = (
    pool: readonly number[],
    forbidden: readonly number[],
    ownFrom: number,
  ): number | undefined => {
    const taken = new Set<number>(forbidden);
    for (const start of [...pool].sort((a, b) => a - b)) {
      // A4 (§3.135): блок ВЫЗЫВАЕМОЙ — три временных клетки, а не пятёрка «0, 1, 8, временный,
      // второй». Постоянные в её плоскости материализуются на месте операции (`movts`), поэтому
      // платить за них клетками бюджета незачем — именно на этой плате пятёрка и не влезала.
      const cells = Array.from({ length: CALLEE_ARRAY_BLOCK_SIZE }, (_, offset) => start + offset);
      if (cells.some((cell) => cell < ownFrom)) continue;
      if (cells.every((cell) => pool.includes(cell) && !taken.has(cell))) return start;
    }
    return undefined;
  };
  /**
   * С КАКОЙ КЛЕТКИ кадр процедуры — СВОЙ (§3.131).
   *
   * У точки входа кадр не сдвинут: свои — все клетки. У вызываемой своя половина начинается за
   * аргументами: `2 * CALL_WBS` (`call wbs = 4` → клетки `%b[8..15]`). Значение берётся из константы
   * соглашения о вызове, а не пишется числом: разойдись они — сторож пропускал бы ровно тот дефект,
   * ради которого поставлен.
   */
  const ownHalfFrom = 2 * CALL_WBS;
  // Арность вызываемых — из самих вызовов, ДО обхода процедур: она нужна каждой вызываемой, а
  // носители `IR.call` живут в потоке вызывающих (см. `argumentCountsOf`).
  const argumentCounts = argumentCountsOf(instructions);
  let removedCopies = 0;
  let materializedConstants = 0;
  procedures.forEach((procedure, index) => {
    const from = procedure.codeOffset;
    const to = index + 1 < procedures.length ? procedures[index + 1]!.codeOffset : instructions.length;
    rewrittenProcedures.push({ name: procedure.name, codeOffset: result.length, vregs: procedure.vregs });
    if (from >= to) return;
    const carriers = instructions.slice(from, to);
    // Цели переходов в носителях — индексы потока МОДУЛЯ, поэтому устранению копий передаётся
    // смещение среза: без него границы блоков не находятся вовсе (измерено, случай 17 реестра).
    const elimination = removeCopies(carriers, { codeOffset: from });
    // Материализация констант идёт ПОСЛЕ устранения копий: она вставляет определения, то есть может
    // сдвинуть индексы ВВЕРХ — поэтому карта индексов строится здесь, а не «сдвигом на число снятых».
    const materialization = rematerializeConstants(elimination.carriers, { codeOffset: from });
    materializedConstants += materialization.materialized.length;
    // Карта «индекс потока МОДУЛЯ → индекс в потоке процедуры»: заполняется окончательными
    // индексами ПОСЛЕ применения раскладки (вытеснение вставляет носители и сдвигает всё дальше).
    const streamIndexOf = new Map<number, number>();
    {
      let survivor = 0;
      for (let local = 0; local < carriers.length; local++) {
        if (elimination.removedAt.includes(local)) continue;
        const movedLocal = materialization.indexOf[survivor];
        if (movedLocal !== undefined && movedLocal >= 0) streamIndexOf.set(from + local, movedLocal);
        survivor++;
      }
    }
    const stream = materialization.instructions;
    // ВИД ПОТОКА ДЛЯ АНАЛИЗА: цели переходов — индексы ЭТОГО потока, а не модуля.
    //
    // Цели в носителях записаны индексами потока МОДУЛЯ (`remapJumpTargets` ниже), а живость, граф и
    // отрезки — величины ЭТОГО потока. Пока пересчёт стоял только в самом конце, анализ шёл по
    // НЕПЕРЕСЧИТАННЫМ целям: снятие копии сдвигало индексы на единицу, ребро вело на соседнюю
    // команду, и значение, переносимое через это ребро, переставало быть живым. Измерено на примере
    // `17-ранжирование-выбором`: выход из внутреннего цикла уезжал на команду, отрезок жизни
    // `контроль` рассыпался на точечные (4 отрезка, 3 разных регистра вместо одного), и `exit`
    // отдавал `индекс` (4) вместо `контроль` (23) — docs/hardware-debt.md §3.35.
    //
    // Сам поток остаётся в индексах модуля: по ним работает пересчёт в конце, а `applySegments` цели
    // не трогает (они не регистры). Поэтому вид — ОТДЕЛЬНЫЙ массив, а не замена потока: иначе карта
    // «модуль → поток» перестала бы совпадать с тем, что лежит в потоке.
    const analysisView = remapJumpTargets(stream, streamIndexOf);
    // СТОРОЖАМ — тот же граф, что раскладке: носители записаны в индексах МОДУЛЯ, цели пересчитаны
    // ЗДЕСЬ, и сторож, собравший граф по носителям, спросил бы не то (см. `collectAnalysis`).
    if (options.collectAnalysis === true) analysis.push({ procedure: procedure.name, instructions: analysisView.instructions });
    const liveness = liveIntervalsOf(analysisView.instructions);
    const incoming = incomingRegisters(stream);
    // ПАРАМЕТРЫ — ЗАКРЕПЛЕНЫ СОГЛАШЕНИЕМ, а не живостью: `i`-й аргумент вызывающий положил в
    // `%b[i]` вызываемой, и раскладка обязана оставить его там, даже если тело параметру
    // ПРИСВАИВАЕТ значение (тогда `incoming` его не видит — см. `argumentCountsOf`).
    const parameters = Array.from({ length: argumentCounts.get(index) ?? 0 }, (_, at) => at);
    const pinned = new Set<number>([...incoming, ...parameters]);
    // Отрезки жизни — по ГРАФУ потока управления (`src/vliw/cfg.ts`), а не по линейному порядку:
    // в цикле значение, определённое в теле, живо в заголовке следующего витка, и линейная модель
    // этого не видит. Граф даёт точный пик (`docs/e2k-regalloc-debt.md` §13: у `фильтр` линейный
    // пик 11 против CFG-занятых 10 и CFG-точных 9).
    const cfg = cfgSegmentsOf(analysisView.instructions);
    // Но одной точной живости не хватает, и вот почему. Отрезки позиционные: `applySegments`
    // отдаёт команде регистр того отрезка, который её НАКРЫВАЕТ. Значение, определённое в теле
    // цикла и прочитанное в заголовке следующего витка, накрывается ДВУМЯ разными отрезками
    // (чтение в заголовке — первым, определение в теле — вторым), и если они получат разные
    // регистры, чтение возьмёт старое значение — цикл не сойдётся. Это не перестраховка:
    // раскладка без слияния ломает FIR — **8** вместо 181 (`.tmp/cfg-experiment.ts`, вариант с
    // переиспользованием регистра) и **0** при снятии слияния с итоговой конфигурации
    // (`.tmp/negative-cfg.ts`, контроль B). Отрезков у `фильтр` при этом 37, после слияния — 24.
    // Слияние соединяет такие отрезки ОДНОГО vreg в один — и только их.
    // Смещение среза здесь 0: `analysisView` уже в координатах потока (см. выше), а не модуля.
    const segments = mergeLoopCarriedSegments(cfg.segments, analysisView.instructions, 0, cfg.liveIn);
    // Переносимые через дугу — те, у кого слияние соединило отрезки: у них было БОЛЬШЕ отрезков,
    // чем стало. Их вытеснение дороже: добавленные обращения к памяти исполняются на каждом витке,
    // и цена это учитывает (`src/vliw/spill.ts`, `LOOP_CARRIED_PENALTY`).
    const rawPerVreg = countSegmentsByVreg(cfg.segments);
    const mergedPerVreg = countSegmentsByVreg(segments);
    const loopCarried = new Set(
      [...rawPerVreg.keys()].filter((vreg) => (rawPerVreg.get(vreg) ?? 0) > (mergedPerVreg.get(vreg) ?? 0)),
    );
    // Закреплённые регистры не отдаются: иначе значение параметра уехало бы из своего регистра.
    // ЗАРЕЗЕРВИРОВАННЫЕ ПОД ОПЕРАЦИЮ (арена — `src/e2k/arenaRuntime.ts`) не отдаются тем более:
    // их пишет и читает сама операция в обход потока носителей, и выданный туда vreg был бы затёрт
    // молча. По умолчанию список пуст: закреплённые числа не двигаются.
    const budget = options.freeFor?.(index) ?? ALLOCATABLE_REGISTERS;
    const free = budget.filter(
      (register) => !pinned.has(register) && !reserved.has(register),
    );
    const allocation = allocateSegments(
      segments.filter((segment) => !pinned.has(segment.vreg)),
      free,
      { spill: spillPlan, loopCarried, instructions: stream },
    );
    const common = {
      procedure: procedure.name,
      vregs: procedure.vregs,
      carriers: carriers.length,
      rewritten: stream.length,
      removedCopies: elimination.removed,
      materializedConstants: materialization.materialized.length,
      peak: liveness.peak,
      peakLive: liveness.peakLive,
      segments: segments.length,
      incoming,
    };
    removedCopies += elimination.removed;
    const base = result.length;
    /** Отказ: поток уходит как есть, а цели переходов остаются на своих местах. */
    const fail = (
      reason: string,
      conflicts: readonly number[],
      unmapped: readonly number[],
      spilled: readonly SpilledValue[],
    ): void => {
      report.push({
        ...common,
        ok: false,
        reason,
        conflicts,
        spilled,
        used: 0,
        usedRegisters: [],
        // Отказ раскладки — это и отказ влезть в окно вызываемой: регистры придётся занять все до
        // единого, а сколько именно, видно по точной границе.
        windowRegistersNeeded: liveness.peakLive + incoming.filter((vreg) => vreg < WINDOW_REGISTERS_ENTRY).length,
        fitsCalleeWindow: false,
        unmapped,
      });
      result.push(...stream);
      for (const [moduleIndex, streamIndex] of streamIndexOf) movedTo.set(moduleIndex, base + streamIndex);
    };
    // Цель перехода, которой не нашлось места в потоке, — отказ, а не молчаливый сдвиг на соседнюю
    // команду (`remapJumpTargets` такие цели не сдвигает, а называет). Проверка стоит здесь, а не
    // раньше, только потому, что отказ оформляется общим `fail`.
    if (analysisView.problems.length > 0) {
      fail(`цели переходов не пересчитаны: ${analysisView.problems.join('; ')}`, [], [], []);
      return;
    }
    if (!allocation.ok) {
      fail(allocation.reason, allocation.conflicts, [], []);
      return;
    }
    const applied = applySegments(stream, allocation.assigned, pinned, allocation.spilled, free);
    // Вытеснение не состоялось (нет свободного регистра в точке сайта) — это отказ раскладки, а не
    // молчаливая потеря значения: поток уходит нерозыгранным, и причина названа.
    if (applied.problems.length > 0) {
      fail(`вытеснение не удалось: ${applied.problems.join('; ')}`, [], applied.unmapped, applied.spilled);
      return;
    }
    // Сколько РЕГИСТРОВ ОКНА занимает процедура: закреплённые (параметры) плюс выданные раскладкой.
    // Закреплённые считаются по своим номерам: параметр приходит в регистре с этим номером.
    const pinnedInWindow = [...pinned].filter((vreg) => vreg < WINDOW_REGISTERS_ENTRY);
    // БЛОК РАНТАЙМА МАССИВОВ этой процедуры (§3.128): точке входа — её измеренные клетки, вызываемой
    // — первая свободная пятёрка её бюджета. Пятёрки нет — базы нет, и понижение откажет ПО ИМЕНИ
    // («раскладка не выдала базу»), а не угадает клетки: тихий путь §3.127 закрыт здесь и там.
    if (arrayProcedures.has(index)) {
      if (index === entryAt) {
        // ТОЧКА ВХОДА: её клетки ИЗМЕРЕНЫ (§3.126) и лежат ВНЕ её пула (`%b[10..14]` при пуле
        // `%b[0..9]`), поэтому значений она не отнимает и сторожей не требует.
        arrayBases[index] = ENTRY_ARRAY_BASE;
      } else {
        // ЯВНЫЙ СПИСОК ЗАПРЕЩЁННЫХ КЛЕТОК — каждое имя называет свой источник (§3.131):
        //   значения раскладки, включая приёмник результата (`used`);
        //   аргументы вызова и входящие значения, закреплённые соглашением (`pinnedInWindow`);
        //   регистры, занятые операцией в обход потока носителей — арена, остаток, коллекции (`reserved`).
        // Своя половина кадра — ГРАНИЦА поиска: клетки ниже `2*wbs` у вызываемой принадлежат
        // вызывающему (его значения и его рантайм), и блок там затирал бы их молча (см. `chooseArrayBlock`).
        const forbidden = [
          ...allocation.allocation.used,
          ...pinnedInWindow,
          ...reserved,
        ];
        arrayBases[index] = chooseArrayBlock(free, forbidden, ownHalfFrom);
      }
    }
    const windowRegistersNeeded = pinnedInWindow.length + allocation.allocation.used.length;
    report.push({
      ...common,
      ok: true,
      conflicts: [],
      spilled: applied.spilled,
      used: allocation.allocation.used.length,
      usedRegisters: allocation.allocation.used,
      windowRegistersNeeded,
      fitsCalleeWindow: windowRegistersNeeded <= WINDOW_REGISTERS_CALLEE,
      unmapped: applied.unmapped,
    });
    result.push(...applied.instructions);
    // Цель перехода — ПЕРВЫЙ носитель, выданный за эту инструкцию: если перед целью вставилось
    // чтение из слота, переход обязан попасть на него, а не за него.
    for (const [moduleIndex, streamIndex] of streamIndexOf) {
      movedTo.set(moduleIndex, base + (applied.firstIndexOf[streamIndex] ?? streamIndex));
    }
  });
  // Цели переходов пересчитываются ПОСЛЕ сборки: сдвиг зависит от снятий во всех процедурах.
  const remapped = remapJumpTargets(result, movedTo);
  if (remapped.problems.length > 0) {
    for (const problem of remapped.problems) {
      report.push({
        procedure: '(цели переходов)',
        vregs: 0,
        carriers: 0,
        rewritten: 0,
        removedCopies: 0,
        peak: 0,
        peakLive: 0,
        segments: 0,
        incoming: [],
        ok: false,
        reason: problem,
        conflicts: [],
        spilled: [],
        used: 0,
        usedRegisters: [],
        windowRegistersNeeded: 0,
        fitsCalleeWindow: false,
        unmapped: [],
      });
    }
  }
  // БУКВА D13: контрактный поток при отказе ПУСТ, диагностический — отдельным полем. Смещения
  // процедур (`rewrittenProcedures`) относятся к диагностическому потоку — они и уезжают в поле
  // вместе с ним, чтобы у потока и его оглавления не было разных ревизий.
  const отказали = report.some((item) => !item.ok);
  return {
    instructions: отказали ? [] : remapped.instructions,
    diagnostic: отказали
      ? { instructions: remapped.instructions, procedures: rewrittenProcedures }
      : undefined,
    procedures: rewrittenProcedures,
    report,
    removedCopies,
    materializedConstants,
    arrayBases,
    analysis,
  };
}
/** Итог раскладки по отрезкам: либо она есть (с вытесненными значениями), либо отказ с причиной. */
export type SegmentAllocationResult =
  | {
      readonly ok: true;
      readonly allocation: Allocation;
      readonly assigned: readonly (LiveInterval & { readonly register: number })[];
      /** Что уехало в память: значение, слот, адрес и цена в обращениях к памяти. */
      readonly spilled: readonly SpilledValue[];
    }
  | {
      readonly ok: false;
      readonly reason: string;
      readonly conflicts: readonly number[];
      readonly assigned: readonly (LiveInterval & { readonly register: number })[];
    };

/** Что нужно раскладке по отрезкам, кроме самих отрезков. */
export interface SegmentAllocationOptions {
  /**
   * План вытеснения. Не передан — вытеснения не делается вовсе (так проверяется негативный
   * контроль: та же программа обязана отказать).
   */
  readonly spill?: SpillOptions;
  /**
   * Значения, переносящие жизнь через обратную дугу цикла: их вытеснение дороже (добавленные
   * обращения к памяти исполняются на каждом витке), и цена это учитывает.
   */
  readonly loopCarried?: ReadonlySet<number>;
  /** Поток процедуры — по нему считается цена вытеснения (чтения и определения значения). */
  readonly instructions?: readonly AsmInstruction[];
}

/**
 * Раскладка по ОТРЕЗКАМ жизни: одному и тому же vreg разные отрезки могут достаться разные
 * регистры — регистр нужен только там, где значение живо.
 *
 * Зачем: интервал-объединение («от первого определения до последнего чтения») держит регистр на
 * всём промежутке, включая мёртвые участки, и потому требует больше регистров, чем нужно по
 * существу. У `фильтр` FIR после устранения копий объединения требуют 11, а точная граница — 9.
 *
 * Здесь же стояло правило «приёмник занимает регистр умирающего чтения» (`liveOut`): у `IR.add d, a, b`,
 * где `a` — последнее чтение, приёмнику `d` хватает регистра `a`. Оно написано и замерено
 * (`.tmp/cfg-experiment3.ts`) — и оказалось бесполезным: в звуковой раскладке тесный момент
 * `фильтр` даёт те же 9 живых отрезков при 8 свободных, отказы те же три процедуры. Правило снято,
 * чтобы не тащить лишнюю посылку в доказательство звуковости.
 *
 * # Вытеснение (минимальное)
 *
 * Регистра не хватило — в память уезжает **самое дешёвое** из активных значений
 * (`src/vliw/spill.ts`: редко читается, не переносится через дугу), и его регистр освобождается.
 * Вытесненных значений на процедуру — не больше `MAX_SPILLS_PER_PROCEDURE`; сверх этого **отказ**,
 * а не тихая потеря значения. Носители вытеснения вставляет {@link applySegments}.
 */
export function allocateSegments(
  segments: readonly LiveInterval[],
  free: readonly number[] = ALLOCATABLE_REGISTERS,
  options: SegmentAllocationOptions = {},
): SegmentAllocationResult {
  // Тот же linear scan, но по отрезкам: vreg в отображении повторяется, и это НЕ ошибка —
  // отображение здесь позиционное (см. applySegments).
  const sorted = [...segments].sort((a, b) => a.start - b.start || a.end - b.end || a.vreg - b.vreg);
  const active: { end: number; register: number; vreg: number }[] = [];
  const assignment = new Map<number, number>();
  const assigned: (LiveInterval & { register: number })[] = [];
  const used = new Set<number>();
  const spilled: { vreg: number; slot: number; address: number }[] = [];
  const spilledVregs = new Set<number>();
  const plan = options.spill;
  const maxSlots = plan?.maxSlots ?? MAX_SPILLS_PER_PROCEDURE;
  const costs =
    plan !== undefined && options.instructions !== undefined
      ? spillCostsOf(options.instructions, {
          defUse: defUseOf,
          ...(options.loopCarried === undefined ? {} : { loopCarried: options.loopCarried }),
        })
      : new Map();
  const sites =
    plan !== undefined && options.instructions !== undefined
      ? spillSitesOf(options.instructions, { defUse: defUseOf })
      : new Map();
  /**
   * Сколько ЧУЖИХ значений занято в этой точке. Считается по отрезкам, а не по живости: раскладка
   * знает ровно отрезки, и именно они решают, есть ли регистр под сайт вытеснения.
   */
  const occupiedAt = (at: number, exclude: number): number => {
    const seen = new Set<number>();
    for (const other of sorted) {
      if (other.vreg === exclude || spilledVregs.has(other.vreg)) continue;
      if (other.start <= at && at <= other.end) seen.add(other.vreg);
    }
    return seen.size;
  };
  const feasible = (vreg: number): boolean => siteFeasible(sites.get(vreg), free.length, (at) => occupiedAt(at, vreg));
  for (const segment of sorted) {
    // Вытесненное значение регистра не занимает: оно живёт в слоте и подгружается в точке чтения.
    if (spilledVregs.has(segment.vreg)) continue;
    for (let index = active.length - 1; index >= 0; index--) {
      // Регистр освобождается, когда отрезок кончился. Соприкосновение (end === start) НЕ
      // освобождает: в этот момент обе величины могут быть живы одновременно.
      if (active[index]!.end < segment.start) {
        // Освобождение регистра НЕ вычёркивает его из `used`: это множество — «сколько
        // регистров раскладка взяла из файла», а не «сколько занято в последний момент». Прежняя
        // редакция вычёркивала, и «занято» означало «занято последним интервалом» (реестр
        // проверяемости, случай 18).
        active.splice(index, 1);
      }
    }
    const held = (): Set<number> => new Set(active.map((entry) => entry.register));
    let register = free.find((candidate) => !held().has(candidate));
    // Регистра нет — вытесняем самое дешёвое из тех, кто его держит, и пробуем снова.
    while (register === undefined && plan !== undefined) {
      if (spilled.length >= maxSlots) {
        const live = sorted.filter((other) => overlaps(other, segment));
        return {
          ok: false,
          reason:
            (maxSlots === 0
              ? 'раскладка по отрезкам невозможна: вытеснение в память (spill) не заказано (предел 0)'
              : `вытеснение не минимально: значений в память нужно больше ${maxSlots} (предел ` +
                '`MAX_SPILLS_PER_PROCEDURE`, src/vliw/spill.ts) — это уже не минимальное вытеснение, ' +
                'а полный аллокатор с вытеснением') +
            `; в тесный момент живы ${live.length} отрезков, ` +
            `свободных регистров ${free.length} (${free.map((value) => `%b[${value}]`).join(', ')})`,
          conflicts: [...new Set(live.map((other) => other.vreg))].sort((a, b) => a - b),
          assigned,
        };
      }
      const victim = chooseSpillVictim(
        active.map((entry) => entry.vreg),
        costs,
        feasible,
      );
      if (victim === undefined) {
        // Активных нет, а регистра всё равно нет: вытеснять некого — это отказ раскладки, а не
        // вытеснения (такой случай возможен, если свободных регистров меньше, чем закреплённых).
        register = undefined;
        break;
      }
      spilledVregs.add(victim);
      spilled.push({ vreg: victim, slot: spilled.length, address: spillAddressOf(plan.base, spilled.length) });
      for (let index = active.length - 1; index >= 0; index--) {
        if (active[index]!.vreg === victim) active.splice(index, 1);
      }
      register = free.find((candidate) => !held().has(candidate));
    }
    if (register === undefined) {
      const live = sorted.filter((other) => overlaps(other, segment));
      return {
        ok: false,
        reason:
          `раскладка по отрезкам невозможна: в тесный момент живы ${live.length} отрезков, ` +
          `свободных регистров ${free.length} (${free.map((value) => `%b[${value}]`).join(', ')}); ` +
          (plan === undefined
            ? 'вытеснение в память (spill) не заказано — передайте план вытеснения'
            : 'вытеснять больше нечего: активных значений нет'),
        conflicts: [...new Set(live.map((other) => other.vreg))].sort((a, b) => a - b),
        assigned,
      };
    }
    assignment.set(segment.vreg, register);
    assigned.push({ ...segment, register });
    active.push({ end: segment.end, register, vreg: segment.vreg });
    active.sort((a, b) => a.end - b.end);
    used.add(register);
  }
  // Назначения вытесненных значений снимаются: их отрезки были назначены ДО того, как значение
  // выбрали жертвой, и с этого момента регистр держать нельзя.
  const kept = assigned.filter((segment) => !spilledVregs.has(segment.vreg));
  for (const segment of kept) assignment.set(segment.vreg, segment.register);
  for (const vreg of spilledVregs) assignment.delete(vreg);
  return {
    ok: true,
    allocation: { assignment, used: [...used].sort((a, b) => a - b) },
    assigned: kept,
    spilled: spilled.map((item) => ({ ...item, accesses: 0 })),
  };
}

/**
 * Применить раскладку по отрезкам: для каждой команды каждый регистр-операнд берёт регистр того
 * отрезка своего vreg, который накрывает эту команду.
 *
 * vreg без отрезка (например, приёмник, которого никто не прочёл: отрезок у него есть, но если
 * раскладка его не назначила) остаётся как есть — и **называется** в `unmapped`.
 *
 * # Вытесненные значения
 *
 * Значение, уехавшее в слот (`src/vliw/spill.ts`), регистра не держит, поэтому носители вытеснения
 * вставляются **здесь** — в поток, уже разложенный по регистрам:
 *
 * * перед каждым **чтением** значения — чтение из слота в регистр, свободный в этой точке;
 * * после каждого **определения** — запись значения в слот.
 *
 * Регистр сайта берётся из свободных **в этой самой команде** (по невытесненным отрезкам), поэтому
 * вытеснение и экономит регистр: длинную жизнь значения заменяют короткие жизни «на одну команду».
 * Один и тот же регистр может обслужить разные сайты.
 *
 * Регистр адреса не может совпасть с регистром значения: `std` читает оба. Если свободного регистра
 * в точке сайта нет — это **названная проблема** (`problems`), а не молчаливая потеря значения.
 */
export function applySegments(
  instructions: readonly AsmInstruction[],
  segments: readonly (LiveInterval & { readonly register: number })[],
  keep: ReadonlySet<number> = new Set(),
  spilled: readonly SpilledValue[] = [],
  free: readonly number[] = ALLOCATABLE_REGISTERS,
): ApplyResult {
  const plan = new Map(spilled.map((item) => [item.vreg, item]));
  const unmapped = new Set<number>();
  const problems: string[] = [];
  const accesses = new Map<number, number>();
  const emitted: AsmInstruction[] = [];
  const firstIndexOf: number[] = [];
  const pool = free.length > 0 ? free : ALLOCATABLE_REGISTERS;
  /** Регистры, занятые в этой команде: закреплённые плюс выданные невытесненным отрезкам. */
  const heldAt = (at: number): Set<number> => {
    const held = new Set<number>(keep);
    for (const segment of segments) {
      if (segment.start <= at && at <= segment.end) held.add(segment.register);
    }
    return held;
  };
  const takeFree = (held: ReadonlySet<number>, exclude: readonly number[]): number | undefined =>
    pool.find((candidate) => !held.has(candidate) && !exclude.includes(candidate));

  instructions.forEach((instruction, at) => {
    firstIndexOf.push(emitted.length);
    const { def, use } = defUseOf(instruction);
    const named = new Set([...def, ...use]);
    const held = heldAt(at);
    // Регистр сайта — одно чтение из слота на ЗНАЧЕНИЕ, а не на операнд: если значение читается
    // дважды одной командой (`IR.add d, a, a`), хватает одного чтения.
    const sites = new Map<number, number>();
    const spilledReads = [...new Set(use)].filter((vreg) => plan.has(vreg)).sort((a, b) => a - b);
    const spilledDefs = [...new Set(def)].filter((vreg) => plan.has(vreg)).sort((a, b) => a - b);
    for (const vreg of spilledReads) {
      const register = takeFree(held, []);
      if (register === undefined) {
        problems.push(`«${instruction.mnemonic}» #${at}: значение v${vreg} вытеснено, но свободного регистра под чтение из слота нет`);
        continue;
      }
      held.add(register);
      sites.set(vreg, register);
      // Чтение из слота: адрес кладётся в тот же регистр, а потом в нём же оказывается значение.
      emitted.push(spillLoadCarrier(register, register, plan.get(vreg)!.address));
      accesses.set(vreg, (accesses.get(vreg) ?? 0) + 1);
    }
    for (const vreg of spilledDefs) {
      if (sites.has(vreg)) continue;
      const register = takeFree(held, []);
      if (register === undefined) {
        problems.push(`«${instruction.mnemonic}» #${at}: приёмник v${vreg} вытеснен, но свободного регистра под запись в слот нет`);
        continue;
      }
      held.add(register);
      sites.set(vreg, register);
    }
    // Сама команда: операнды вытесненных значений получают регистр своего сайта.
    emitted.push({
      ...instruction,
      operands: instruction.operands.map((operand) => {
        if (operand.kind !== 'reg') return operand;
        // Слот, которого носитель не читает и не пишет (`IR.ret imm(0), reg(N)`), — не значение:
        // он не отображается и в `unmapped` не попадает.
        if (!named.has(operand.index)) return operand;
        // Закреплённый vreg (входящий параметр) остаётся в своём регистре — и это не «неотображён».
        if (keep.has(operand.index)) return operand;
        const site = sites.get(operand.index);
        if (site !== undefined) return { ...operand, index: site };
        const covering = segments.filter(
          (segment) => segment.vreg === operand.index && segment.start <= at && at <= segment.end,
        );
        if (covering.length === 0) {
          unmapped.add(operand.index);
          return operand;
        }
        // Если отрезков несколько (не должно быть), берём самый узкий — он точнее.
        const narrowest = covering.reduce((best, current) =>
          current.end - current.start < best.end - best.start ? current : best,
        );
        return { ...operand, index: narrowest.register };
      }),
    });
    // Запись в слот — сразу после определения значения.
    for (const vreg of spilledDefs) {
      const value = sites.get(vreg);
      if (value === undefined) continue; // причину уже назвали выше
      const address = takeFree(held, [value]);
      if (address === undefined) {
        problems.push(`«${instruction.mnemonic}» #${at}: значение v${vreg} вытеснено, но регистра под адрес слота нет`);
        continue;
      }
      held.add(address);
      emitted.push(spillStoreCarrier(value, address, plan.get(vreg)!.address));
      accesses.set(vreg, (accesses.get(vreg) ?? 0) + 1);
    }
  });
  return {
    instructions: emitted,
    unmapped: [...unmapped].sort((a, b) => a - b),
    spilled: spilled.map((item) => ({ ...item, accesses: accesses.get(item.vreg) ?? 0 })),
    firstIndexOf,
    problems,
  };
}
/** Итог применения раскладки к потоку носителей. */
export interface ApplyResult {
  readonly instructions: readonly AsmInstruction[];
  /** vreg'и, которых не было в раскладке: они остались со своими номерами. */
  readonly unmapped: readonly number[];
  /** Вытесненные значения с ценой в обращениях к памяти. */
  readonly spilled: readonly SpilledValue[];
  /**
   * С какого индекса в новом потоке начинается каждая команда исходного.
   *
   * Нужно для целей переходов: если перед командой-целью вставилось чтение из слота, целью обязана
   * стать эта вставка, иначе переход проскочит подгрузку и значение останется старым.
   */
  readonly firstIndexOf: readonly number[];
  /** Почему вытеснение не состоялось: свободного регистра в точке сайта не нашлось. */
  readonly problems: readonly string[];
}

/**
 * Заменить номера vreg'ов на физические регистры.
 *
 * Неотображённые vreg'и остаются как есть, но **называются** в `unmapped`: молчаливое «оставили
 * как было» — это как раз тот случай, когда программа затирает рантайм и никто об этом не знает.
 */
export function applyAllocation(
  instructions: readonly AsmInstruction[],
  assignment: ReadonlyMap<number, number>,
  keep: ReadonlySet<number> = new Set(),
): { readonly instructions: readonly AsmInstruction[]; readonly unmapped: readonly number[] } {
  const unmapped = new Set<number>();
  const mapped = instructions.map((instruction) => {
    const named = namedRegisters(instruction);
    const operands: Operand[] = instruction.operands.map((operand) => {
      if (operand.kind !== 'reg') return operand;
      if (!named.has(operand.index)) return operand;
      if (keep.has(operand.index)) return operand;
      const physical = assignment.get(operand.index);
      if (physical === undefined) {
        unmapped.add(operand.index);
        return operand;
      }
      return { ...operand, index: physical };
    });
    return { ...instruction, operands };
  });
  return { instructions: mapped, unmapped: [...unmapped].sort((a, b) => a - b) };
}

/**
 * Закрепление входящих vreg'ов: их регистры не отдаются раскладке.
 *
 * Нужно там, где раскладка применяется к потоку целиком (`applySegments`): закреплённый vreg
 * остаётся как есть и в `unmapped` не попадает — «не отображён» и «закреплён» это разные вещи.
 */
export function pinRegisters(incoming: readonly number[]): ReadonlySet<number> {
  return new Set(incoming);
}
