/**
 * ГРАФ ПОТОКА УПРАВЛЕНИЯ (CFG) И ТОЧНАЯ ЖИВОСТЬ ЗНАЧЕНИЙ.
 *
 * # Зачем этот файл
 *
 * Жизнь значений считалась **линейно**: отрезок `[start, end]` по порядку носителей
 * (`src/e2k/liveness.ts`, `liveSegmentsOf`). В цикле это неверно: значение, определённое в теле,
 * живо в **заголовке следующего витка**, а по индексам определение стоит ПОСЛЕ использования.
 * Линейная модель такого не видит (ноль жизни), и лечилось это слиянием отрезков через дугу
 * (`mergeLoopCarriedSegments`) — симптом снят, пик завышен (`docs/e2k-regalloc-debt.md` §2, §4).
 *
 * **Слияние граф не отменяет, и это измерено.** Отрезки, построенные по множествам живости,
 * остаются **позиционными** (`applySegments` отдаёт команде регистр накрывающего отрезка), а
 * значение, переносимое через дугу, накрывается двумя разными отрезками — и обязано жить в ОДНОМ
 * регистре. Снятие слияния с итоговой раскладки даёт FIR = **0** вместо 181
 * (`.tmp/negative-cfg.ts`, контроль B); подробности и таблица — §13 того же документа.
 *
 * Здесь та же жизнь считается там, где она есть: по графу. `liveIn`/`liveOut` — итеративный
 * анализ назад до неподвижной точки, по **базовым блокам** (а не по отдельным инструкциям), как
 * и положено анализу потока.
 *
 * # Три величины, и они не равны друг другу
 *
 * | величина | что это | зачем |
 * |---|---|---|
 * | {@link cfgLiveSets} | `liveIn`/`liveOut` по инструкциям | источник истины о жизни |
 * | {@link cfgRanges} | отрезки «значение обязано быть в регистре» (`liveIn ∪ liveOut ∪ def`) | вход раскладки |
 * | {@link cfgPressure}.peak | максимум занятых значений по инструкции | линейная граница: столько нужно раскладке, если соприкосновение считать конфликтом |
 * | {@link cfgPressure}.exact | то же, но приёмник может занять регистр **умирающего чтения** | точная нижняя граница: железо читает операнды до записи приёмника |
 *
 * `peak` и `exact` различаются ровно на переиспользовании: у `IR.add d, a, b`, где `a` и `b` — их
 * последнее чтение, приёмнику `d` достаточно одного из освободившихся регистров, а не нового.
 *
 * # Почему `defUse` передаётся снаружи
 *
 * Раскладка операндов носителя — знание эмиттера (`src/e2k/emitterShell.ts`), и этот модуль
 * намеренно его не импортирует: иначе получился бы цикл `e2k → vliw → e2k`. Вызывающий передаёт
 * функцию «что носитель пишет и что читает» (`src/e2k/liveness.ts`, `defUseOf`).
 */

import type { AsmInstruction } from '../e2k/backend';

/** Что носитель пишет и что читает. */
export interface DefUse {
  readonly def: readonly number[];
  readonly use: readonly number[];
}

/** Настройки анализа. */
export interface CfgOptions {
  /** Что носитель пишет и читает, по его мнемонике и операндам. */
  readonly defUse: (instruction: AsmInstruction) => DefUse;
  /**
   * Считать ли обратные дуги. `true` — НЕ считать: нужно только негативному контролю, который
   * доказывает, что именно учёт дуг делает переносимые значения живыми.
   */
  readonly ignoreBackEdges?: boolean;
}

/** Ребро «назад»: цель перехода стоит раньше самого перехода. */
export interface CfgEdge {
  readonly from: number;
  readonly to: number;
}

/** Базовый блок: непрерывный участок инструкций с одним входом и одним выходом. */
export interface BasicBlock {
  readonly index: number;
  readonly start: number;
  readonly end: number;
  readonly successors: readonly number[];
  readonly predecessors: readonly number[];
}

/** Граф потока управления по инструкциям. */
export interface Cfg {
  readonly successors: readonly (readonly number[])[];
  readonly predecessors: readonly (readonly number[])[];
  readonly blocks: readonly BasicBlock[];
  readonly backEdges: readonly CfgEdge[];
}

/** Цель перехода в операндах носителя (`src/e2k/twoPassLayout.ts`: 0 у `IR.jmp`, 1 у условных). */
const JUMP_TARGET: Readonly<Record<string, number>> = {
  'IR.jmp': 0,
  'IR.jmp_if': 1,
  'IR.jmp_if_not': 1,
};

const isJump = (mnemonic: string): boolean =>
  mnemonic === 'IR.jmp' || mnemonic === 'IR.jmp_if' || mnemonic === 'IR.jmp_if_not';

/** Безусловный ли переход: у него нет падения на следующую инструкцию. */
const isUnconditional = (mnemonic: string): boolean => mnemonic === 'IR.jmp';

/** Цель перехода, если она названа числом и попадает в поток. */
export function jumpTargetOf(instruction: AsmInstruction, length: number): number | undefined {
  const at = JUMP_TARGET[instruction.mnemonic];
  if (at === undefined) return undefined;
  const operand = instruction.operands[at];
  if (operand === undefined || operand.kind !== 'imm') return undefined;
  if (!Number.isInteger(operand.value) || operand.value < 0 || operand.value >= length) return undefined;
  return operand.value;
}

/**
 * Построить граф потока управления.
 *
 * Базовые блоки выделяются по **лидерам**: вход процедуры, цели переходов и инструкции,
 * следующие за переходом (падение). Переходы внутри блока не разрывают его — лидером делает
 * только цель.
 */
export function buildCfg(instructions: readonly AsmInstruction[], options: { ignoreBackEdges?: boolean } = {}): Cfg {
  const length = instructions.length;
  const successors: number[][] = instructions.map(() => []);
  instructions.forEach((instruction, at) => {
    const target = jumpTargetOf(instruction, length);
    const fallsThrough = !isUnconditional(instruction.mnemonic);
    if (fallsThrough && at + 1 < length) successors[at]!.push(at + 1);
    if (target !== undefined && !(options.ignoreBackEdges === true && target <= at)) {
      successors[at]!.push(target);
    }
  });

  const predecessors: number[][] = instructions.map(() => []);
  successors.forEach((list, from) => {
    for (const to of list) predecessors[to]!.push(from);
  });

  const backEdges: CfgEdge[] = [];
  successors.forEach((list, from) => {
    for (const to of list) if (to <= from) backEdges.push({ from, to });
  });

  // Лидеры: 0, цели переходов, инструкции после перехода.
  const leaders = new Set<number>();
  if (length > 0) leaders.add(0);
  instructions.forEach((instruction, at) => {
    const target = jumpTargetOf(instruction, length);
    if (target !== undefined) leaders.add(target);
    if (isJump(instruction.mnemonic) && at + 1 < length) leaders.add(at + 1);
  });
  const sortedLeaders = [...leaders].filter((at) => at < length).sort((a, b) => a - b);

  // Границы блоков, затем связи между блоками, и только потом сами блоки — так типы остаются
  // неизменяемыми, без приведений «readonly → mutable».
  const bounds: { start: number; end: number }[] = [];
  const blockOfInstruction: number[] = instructions.map(() => -1);
  sortedLeaders.forEach((start, index) => {
    const end = (index + 1 < sortedLeaders.length ? sortedLeaders[index + 1]! : length) - 1;
    if (end < start) return;
    for (let at = start; at <= end; at++) blockOfInstruction[at] = bounds.length;
    bounds.push({ start, end });
  });

  const blockSuccessors: number[][] = bounds.map(() => []);
  const blockPredecessors: number[][] = bounds.map(() => []);
  bounds.forEach((bound, index) => {
    const out = new Set<number>();
    for (let at = bound.start; at <= bound.end; at++) {
      for (const successor of successors[at]!) {
        const target = blockOfInstruction[successor];
        if (target !== undefined && target >= 0 && target !== index) out.add(target);
      }
    }
    blockSuccessors[index] = [...out].sort((a, b) => a - b);
  });
  blockSuccessors.forEach((list, index) => {
    for (const successor of list) blockPredecessors[successor]!.push(index);
  });
  const blocks: BasicBlock[] = bounds.map((bound, index) => ({
    index,
    start: bound.start,
    end: bound.end,
    successors: blockSuccessors[index]!,
    predecessors: [...blockPredecessors[index]!].sort((a, b) => a - b),
  }));

  return {
    successors: successors.map((list) => [...list]),
    predecessors: predecessors.map((list) => [...list]),
    blocks,
    backEdges,
  };
}

/** Живые на входе и на выходе каждой инструкции. */
export interface CfgLiveSets {
  readonly liveIn: readonly (readonly number[])[];
  readonly liveOut: readonly (readonly number[])[];
  /** Живые на входе и выходе каждого блока (то, что считает анализ до неподвижной точки). */
  readonly blockLiveIn: readonly (readonly number[])[];
  readonly blockLiveOut: readonly (readonly number[])[];
}

/**
 * Точная живость: `liveIn`/`liveOut` по инструкциям, неподвижная точка по блокам.
 *
 * Анализ идёт **назад**: `liveOut(блок) = ⋃ liveIn(преемников)`, `liveIn(блок) = use(блок) ∪
 * (liveOut(блок) − def(блок))`, пока множества не перестанут меняться. Затем внутри блока
 * множества уточняются по инструкциям обратным проходом (`liveOut(at) = ⋃ liveIn(преемников
 * инструкции)`, `liveIn(at) = use ∪ (liveOut − def)`).
 *
 * Такой порядок важен именно для циклов: заголовок не «знает» о теле, пока тело не посчитано,
 * поэтому одного прохода мало — нужна неподвижная точка.
 */
export function cfgLiveSets(instructions: readonly AsmInstruction[], options: CfgOptions): CfgLiveSets {
  const cfg = buildCfg(instructions, options);
  const { defUse } = options;

  // use/def по инструкциям — считаются один раз.
  const defs = instructions.map((instruction) => new Set(defUse(instruction).def));
  const uses = instructions.map((instruction) => new Set(defUse(instruction).use));

  const blockLiveIn = cfg.blocks.map(() => new Set<number>());
  const blockLiveOut = cfg.blocks.map(() => new Set<number>());
  let changed = true;
  while (changed) {
    changed = false;
    for (let index = cfg.blocks.length - 1; index >= 0; index--) {
      const block = cfg.blocks[index]!;
      const out = new Set<number>();
      for (const successor of block.successors) for (const vreg of blockLiveIn[successor]!) out.add(vreg);
      const inSet = new Set<number>(out);
      // Обратный проход: определение внутри блока убивает более РАННЕЕ чтение того же vreg'а,
      // поэтому порядок обязателен — прямой проход посчитал бы убитое значение живым на входе.
      for (let at = block.end; at >= block.start; at--) {
        for (const vreg of defs[at]!) inSet.delete(vreg);
        for (const vreg of uses[at]!) inSet.add(vreg);
      }
      const same =
        sameSet(out, blockLiveOut[index]!) && sameSet(inSet, blockLiveIn[index]!);
      if (!same) {
        blockLiveOut[index] = out;
        blockLiveIn[index] = inSet;
        changed = true;
      }
    }
  }

  // Уточнение по инструкциям внутри блоков — обратным проходом.
  //
  // Выход последней инструкции блока берётся из УЖЕ сошедшихся множеств блока
  // (`blockLiveOut`), а не из `liveIn` преемников: у цикла преемник — заголовок, стоящий
  // РАНЬШЕ по потоку, и на момент прохода он ещё не посчитан. Переходы в середине блока
  // невозможны (лидером становится инструкция после любого перехода), поэтому у остальных
  // инструкций единственный преемник — следующая, она в этом же проходе уже посчитана.
  const liveIn: Set<number>[] = instructions.map(() => new Set<number>());
  const liveOut: Set<number>[] = instructions.map(() => new Set<number>());
  for (let index = cfg.blocks.length - 1; index >= 0; index--) {
    const block = cfg.blocks[index]!;
    for (let at = block.end; at >= block.start; at--) {
      const out = new Set<number>(blockLiveOut[index]!);
      if (at !== block.end) {
        out.clear();
        for (const successor of cfg.successors[at]!) for (const vreg of liveIn[successor]!) out.add(vreg);
      }
      const inSet = new Set<number>(out);
      for (const vreg of defs[at]!) inSet.delete(vreg);
      for (const vreg of uses[at]!) inSet.add(vreg);
      liveOut[at] = out;
      liveIn[at] = inSet;
    }
  }

  const asArray = (sets: readonly Set<number>[]): number[][] =>
    sets.map((set) => [...set].sort((a, b) => a - b));
  return {
    liveIn: asArray(liveIn),
    liveOut: asArray(liveOut),
    blockLiveIn: asArray(blockLiveIn),
    blockLiveOut: asArray(blockLiveOut),
  };
}

function sameSet(a: ReadonlySet<number>, b: ReadonlySet<number>): boolean {
  return a.size === b.size && [...a].every((value) => b.has(value));
}

/** Отрезок жизни: `[start, end]` — участок, на котором значение обязано быть в регистре. */
export interface LiveRange {
  readonly vreg: number;
  readonly start: number;
  readonly end: number;
}

/**
 * Отрезки «значение обязано быть в регистре» — из множеств живости, а не из линейного порядка.
 *
 * Значение обязано быть в регистре там, где оно живо (`liveIn` или `liveOut`) или где оно
 * **определяется** (приёмник тоже занимает регистр). Отрезок рвётся, когда значение перестаёт быть
 * живым: тогда регистр свободен для других.
 */
export function cfgRanges(instructions: readonly AsmInstruction[], options: CfgOptions): LiveRange[] {
  const { liveIn, liveOut } = cfgLiveSets(instructions, options);
  const { defUse } = options;
  const ranges: LiveRange[] = [];
  const open = new Map<number, number>();
  instructions.forEach((instruction, at) => {
    const alive = new Set<number>([...liveIn[at]!, ...liveOut[at]!, ...defUse(instruction).def]);
    for (const [vreg, start] of [...open]) {
      if (!alive.has(vreg)) {
        ranges.push({ vreg, start, end: at - 1 });
        open.delete(vreg);
      }
    }
    for (const vreg of alive) if (!open.has(vreg)) open.set(vreg, at);
  });
  const last = instructions.length - 1;
  for (const [vreg, start] of open) ranges.push({ vreg, start, end: Math.max(start, last) });
  return ranges;
}

/** Точная граница числа регистров. */
export interface CfgPressure {
  /** Максимум занятых значений в инструкции: `|liveIn ∪ liveOut ∪ def|`. */
  readonly peak: number;
  readonly peakAt: number;
  /**
   * Точная нижняя граница: то же, но приёмник может занять регистр **умирающего чтения**
   * (железо читает операнды до записи приёмника). Меньше этого числа не обойтись никакой раскладке.
   */
  readonly exact: number;
  readonly exactAt: number;
  /** Где именно тесно: значения, которым нужны разные регистры. */
  readonly exactSet: readonly number[];
}

/**
 * Граница числа регистров по инструкциям.
 *
 * `exact` считается так: регистры нужны значениям, которые **переживают** инструкцию (`liveOut`),
 * и значениям, которые в ней **читаются и умирают** (`liveIn − liveOut`). Приёмник может занять
 * регистр одного умирающего чтения — тогда они делят его пополам. Если приёмника нет, а чтение
 * умирает, регистр чтения просто освобождается после инструкции и в границу не входит.
 */
export function cfgPressure(instructions: readonly AsmInstruction[], options: CfgOptions): CfgPressure {
  const { liveIn, liveOut } = cfgLiveSets(instructions, options);
  const { defUse } = options;
  let peak = 0;
  let peakAt = -1;
  let exact = 0;
  let exactAt = -1;
  let exactSet: number[] = [];
  instructions.forEach((instruction, at) => {
    const inSet = new Set(liveIn[at]!);
    const outSet = new Set(liveOut[at]!);
    const def = new Set(defUse(instruction).def);
    const busy = new Set<number>([...inSet, ...outSet, ...def]);
    if (busy.size > peak) {
      peak = busy.size;
      peakAt = at;
    }
    const dying = new Set<number>([...inSet].filter((vreg) => !outSet.has(vreg)));
    const needed = new Set<number>([...outSet]);
    // Умирающие чтения занимают регистры во время чтения; приёмник может занять один из них.
    const shareable = [...dying].length > 0 && def.size > 0;
    for (const vreg of dying) needed.add(vreg);
    const value = needed.size - (shareable ? 1 : 0) + (def.size > 0 && [...def].every((vreg) => !outSet.has(vreg)) && !shareable ? 1 : 0);
    if (value > exact) {
      exact = value;
      exactAt = at;
      exactSet = [...needed].sort((a, b) => a - b);
    }
  });
  return { peak, peakAt, exact, exactAt, exactSet };
}
