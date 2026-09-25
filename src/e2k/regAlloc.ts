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
 * 4. Если свободных нет — **отказ** с числом одновременно живых и списком конфликтующих vreg'ов.
 *
 * `spill` (вытеснение в память) здесь НЕ делается: это следующий слой, и молчаливая перезапись
 * чужого значения недопустима — отказ обязан быть названным.
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
import { rematerializeConstants } from './rematerialize';

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

/** Свободные регистры раскладки: `%b[0..9]`. */
export const ALLOCATABLE_REGISTERS: readonly number[] = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9];

/**
 * Регистров окна у **вызывающего** (точка входа) — `%r0..%r15`.
 *
 * Измерено прогоном (`.tmp/rsz-sweep.ts`): при `setbn rsz = 7` доступны `%b[0..15]`, дальше окно не
 * пускает (начальные `psize_q = 4`, `size_q = 8` квадрослов — `qemu/linux-user/e2k/cpu_loop.c:302-303`).
 */
export const WINDOW_REGISTERS_ENTRY = 16;

/**
 * Регистров окна у **вызываемой** процедуры — `%r0..%r7`.
 *
 * Измерено прогоном в модели (`src/e2k/e2kCallWindowQemu.test.ts`, `.tmp/call-window3.ts`): при
 * `call %ctpr1, wbs=4` запись в `%r5` и `%r7` проходит, а в `%r8`, `%r9`, `%r10` — ловушка на первой
 * команде тела. Сходится с исходником модели: `call` делает `size_q -= wbs` (`size_q` 8 → 4), а
 * индекс окна считается как `(base_d + idx) % MAXSR_D` с проверкой `idx < size_d = 2*size_q`
 * (`qemu/target/e2k/tcg/translate-ct.c`, `e2k_cpu_exec_ct_CALL`; `reg-index.h:55-81`).
 *
 * Следствие: процедура, которой нужно больше восьми регистров, **вызвана быть не может** — а
 * `фильтр` ядра FIR занимает десять (`%b[0..9]`). Расширение окна — `setwd` (измерено, но отложено:
 * с памятью модель ведёт себя неустойчиво) или вытеснение в память (следующий слой).
 */
export const WINDOW_REGISTERS_CALLEE = 8;

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
export function incomingRegisters(instructions: readonly AsmInstruction[]): readonly number[] {
  const defined = new Set<number>();
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
 */
export function allocateProgram(
  instructions: readonly AsmInstruction[],
  procedures: readonly { readonly name: string; readonly codeOffset: number; readonly vregs: number }[],
): {
  readonly instructions: readonly AsmInstruction[];
  readonly procedures: readonly { readonly name: string; readonly codeOffset: number; readonly vregs: number }[];
  readonly report: readonly ProcedureAllocation[];
  readonly removedCopies: number;
  /** Сколько определений констант размножено (§7.12 docs/e2k-opcodes-real.md). */
  readonly materializedConstants: number;
} {
  const result: AsmInstruction[] = [];
  const rewrittenProcedures: { name: string; codeOffset: number; vregs: number }[] = [];
  const report: ProcedureAllocation[] = [];
  // «Старый индекс потока модуля → новый»: по нему пересчитываются цели переходов ПОСЛЕ сборки.
  const movedTo = new Map<number, number>();
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
    { // карта: исходный локальный индекс → новый локальный индекс
      let survivor = 0;
      for (let local = 0; local < carriers.length; local++) {
        if (elimination.removedAt.includes(local)) continue;
        const movedLocal = materialization.indexOf[survivor];
        if (movedLocal !== undefined && movedLocal >= 0) movedTo.set(from + local, result.length + movedLocal);
        survivor++;
      }
    }
    const stream = materialization.instructions;
    const liveness = liveIntervalsOf(stream);
    const incoming = incomingRegisters(stream);
    // Отрезки жизни — по ГРАФУ потока управления (`src/vliw/cfg.ts`), а не по линейному порядку:
    // в цикле значение, определённое в теле, живо в заголовке следующего витка, и линейная модель
    // этого не видит. Граф даёт точный пик (`docs/e2k-regalloc-debt.md` §13: у `фильтр` линейный
    // пик 11 против CFG-занятых 10 и CFG-точных 9).
    const cfg = cfgSegmentsOf(stream);
    // Но одной точной живости не хватает, и вот почему. Отрезки позиционные: `applySegments`
    // отдаёт команде регистр того отрезка, который её НАКРЫВАЕТ. Значение, определённое в теле
    // цикла и прочитанное в заголовке следующего витка, накрывается ДВУМЯ разными отрезками
    // (чтение в заголовке — первым, определение в теле — вторым), и если они получат разные
    // регистры, чтение возьмёт старое значение — цикл не сойдётся. Это не перестраховка:
    // раскладка без слияния ломает FIR — **8** вместо 181 (`.tmp/cfg-experiment.ts`, вариант с
    // переиспользованием регистра) и **0** при снятии слияния с итоговой конфигурации
    // (`.tmp/negative-cfg.ts`, контроль B). Отрезков у `фильтр` при этом 37, после слияния — 24.
    // Слияние соединяет такие отрезки ОДНОГО vreg в один — и только их.
    const segments = mergeLoopCarriedSegments(cfg.segments, stream, from);
    // Закреплённые регистры не отдаются: иначе значение параметра уехало бы из своего регистра.
    const free = ALLOCATABLE_REGISTERS.filter((register) => !incoming.includes(register));
    const allocation = allocateSegments(
      segments.filter((segment) => !incoming.includes(segment.vreg)),
      free,
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
    if (!allocation.ok) {
      report.push({
        ...common,
        ok: false,
        reason: allocation.reason,
        conflicts: allocation.conflicts,
        used: 0,
        usedRegisters: [],
        // Отказ раскладки — это и отказ влезть в окно вызываемой: регистры придётся занять все до
        // единого, а сколько именно, видно по точной границе.
        windowRegistersNeeded: liveness.peakLive + incoming.filter((vreg) => vreg < WINDOW_REGISTERS_ENTRY).length,
        fitsCalleeWindow: false,
        unmapped: [],
      });
      result.push(...stream);
      return;
    }
    const applied = applySegments(stream, allocation.assigned, new Set(incoming));
    // Сколько РЕГИСТРОВ ОКНА занимает процедура: закреплённые (параметры) плюс выданные раскладкой.
    // Закреплённые считаются по своим номерам: параметр приходит в регистре с этим номером.
    const pinned = incoming.filter((vreg) => vreg < WINDOW_REGISTERS_ENTRY);
    const windowRegistersNeeded = pinned.length + allocation.allocation.used.length;
    report.push({
      ...common,
      ok: true,
      conflicts: [],
      used: allocation.allocation.used.length,
      usedRegisters: allocation.allocation.used,
      windowRegistersNeeded,
      fitsCalleeWindow: windowRegistersNeeded <= WINDOW_REGISTERS_CALLEE,
      unmapped: applied.unmapped,
    });
    result.push(...applied.instructions);
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
        used: 0,
        usedRegisters: [],
        windowRegistersNeeded: 0,
        fitsCalleeWindow: false,
        unmapped: [],
      });
    }
  }
  return { instructions: remapped.instructions, procedures: rewrittenProcedures, report, removedCopies, materializedConstants };
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
 */
export function allocateSegments(
  segments: readonly LiveInterval[],
  free: readonly number[] = ALLOCATABLE_REGISTERS,
): AllocationResult & { readonly assigned: readonly (LiveInterval & { readonly register: number })[] } {
  // Тот же linear scan, но по отрезкам: vreg в отображении повторяется, и это НЕ ошибка —
  // отображение здесь позиционное (см. applySegments).
  const sorted = [...segments].sort((a, b) => a.start - b.start || a.end - b.end);
  const active: { end: number; register: number }[] = [];
  const assignment = new Map<number, number>();
  const assigned: (LiveInterval & { register: number })[] = [];
  const used = new Set<number>();
  for (const segment of sorted) {
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
    const taken = new Set(active.map((entry) => entry.register));
    const register = free.find((candidate) => !taken.has(candidate));
    if (register === undefined) {
      const live = sorted.filter((other) => overlaps(other, segment));
      return {
        ok: false,
        reason:
          `раскладка по отрезкам невозможна: в тесный момент живы ${live.length} отрезков, ` +
          `свободных регистров ${free.length} (${free.map((value) => `%b[${value}]`).join(', ')}); ` +
          'вытеснение в память (spill) здесь не делается — это следующий слой',
        conflicts: [...new Set(live.map((other) => other.vreg))].sort((a, b) => a - b),
        assigned,
      };
    }
    assignment.set(segment.vreg, register);
    assigned.push({ ...segment, register });
    active.push({ end: segment.end, register });
    active.sort((a, b) => a.end - b.end);
    used.add(register);
  }
  return { ok: true, allocation: { assignment, used: [...used].sort((a, b) => a - b) }, assigned };
}

/**
 * Применить раскладку по отрезкам: для каждой команды каждый регистр-операнд берёт регистр того
 * отрезка своего vreg, который накрывает эту команду.
 *
 * vreg без отрезка (например, приёмник, которого никто не прочёл: отрезок у него есть, но если
 * раскладка его не назначила) остаётся как есть — и **называется** в `unmapped`.
 */
export function applySegments(
  instructions: readonly AsmInstruction[],
  segments: readonly (LiveInterval & { readonly register: number })[],
  keep: ReadonlySet<number> = new Set(),
): ApplyResult {
  const unmapped = new Set<number>();
  const mapped = instructions.map((instruction, at) => {
    const named = namedRegisters(instruction);
    return {
      ...instruction,
      operands: instruction.operands.map((operand) => {
        if (operand.kind !== 'reg') return operand;
        // Слот, которого носитель не читает и не пишет (`IR.ret imm(0), reg(N)`), — не значение:
        // он не отображается и в `unmapped` не попадает.
        if (!named.has(operand.index)) return operand;
        // Закреплённый vreg (входящий параметр) остаётся в своём регистре — и это не «неотображён».
        if (keep.has(operand.index)) return operand;
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
    };
  });
  return { instructions: mapped, unmapped: [...unmapped].sort((a, b) => a - b) };
}
/** Итог применения раскладки к потоку носителей. */
export interface ApplyResult {
  readonly instructions: readonly AsmInstruction[];
  /** vreg'и, которых не было в раскладке: они остались со своими номерами. */
  readonly unmapped: readonly number[];
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
): ApplyResult {
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
