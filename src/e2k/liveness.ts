/**
 * ЖИЗНЬ ЗНАЧЕНИЙ (LIVENESS) В ПОТОКЕ НОСИТЕЛЕЙ e2k.
 *
 * # Зачем
 *
 * Регистров мало: свободно `%b[0..9]` — десять (`%b[10..15]` держит рантайм массивов), окно
 * больше не расширяется (`setwd` отложен, `docs/e2k-setwd-memory.md`). Значит vreg'ы нужно
 * раскладывать по **интервалам жизни**, а не по номеру.
 *
 * # Что считается
 *
 * Интервал — `[определение, последнее чтение]` по **линейному** порядку носителей. Переопределение
 * vreg'а **закрывает** прежний интервал и открывает новый: значение — не безымянная ячейка, а
 * результат конкретной команды. Так же читается и `peak` — наибольшее число интервалов, живых
 * одновременно, то есть нижняя граница числа нужных регистров.
 *
 * # Откуда известно, что носитель читает и что пишет
 *
 * Не из догадки: раскладка операндов носителя зафиксирована эмиттером оболочки —
 * `src/e2k/emitterShell.ts:205-298`:
 *
 * | носитель | операнды | пишет | читает |
 * |---|---|---|---|
 * | `IR.const` | `[d, индекс пула, тип]` | 0 | — |
 * | `IR.move`, `IR.not` | `[d, a]` | 0 | 1 |
 * | `IR.jmp` | `[смещение]` | — | — |
 * | `IR.jmp_if`, `IR.jmp_if_not` | `[условие, смещение]` | — | 0 |
 * | `IR.call`, `IR.invoke` | `[флаги, arg0, arg1, payload, приёмник]` | 4 (если `флаги & 1`) | `arg0…` (`флаги >> 1` штук) |
 * | `IR.ret` | `[есть значение, регистр]` | — | 1 (если флаг) |
 * | прочие (арифметика, сравнения) | `[d, a, b]` | 0 | 1, 2 |
 *
 * Групповые носители (`IR.gt`, `IR.add`, …) идут по последней строке: их раскладка в эмиттере
 * общая — «остальные операции с носителем».
 *
 * # Чего здесь нет
 *
 * Нет анализа потока управления: порядок носителей берётся линейным, как их выдаёт эмиттер
 * (переходы уже разложены двухпроходной раскладкой, а тела процедур идут подряд). Для циклов это
 * даёт **более длинные** интервалы, чем нужно, то есть оценка консервативна: если раскладка
 * удалась на таких интервалах, она корректна и на точных.
 */

import type { AsmInstruction } from './backend';

/** Что носитель пишет и что читает (номера vreg'ов). */
export interface DefUse {
  readonly def: readonly number[];
  readonly use: readonly number[];
}

/** Интервал жизни значения: `[start, end]` — индексы носителей в списке. */
export interface LiveInterval {
  readonly vreg: number;
  readonly start: number;
  readonly end: number;
}

/** Результат анализа: интервалы и наибольшее число одновременно живых. */
export interface Liveness {
  readonly intervals: readonly LiveInterval[];
  /**
   * Нижняя граница числа регистров **по раскладке**: столько интервалов-объединений живут
   * одновременно. Так считает linear scan (один регистр на vreg), поэтому именно это число решает,
   * влезает раскладка или нет.
   */
  readonly peak: number;
  /** Где этот момент: индекс носителя. */
  readonly peakAt: number;
  /**
   * Точная нижняя граница: максимум живых на выходе инструкции по **настоящему** анализу жизни
   * (обратный обход с учётом переходов). Меньше неё не обойтись ни одной раскладке, даже если
   * каждому отрезку жизни давать свой регистр: в этот момент все они живы одновременно.
   */
  readonly peakLive: number;
  /** Где точный максимум: индекс носителя. */
  readonly peakLiveAt: number;
}

/**
 * Преемники носителя: следующий по порядку и цель перехода.
 *
 * Без этого анализ жизни был бы **небезопасен**: в цикле значение, живое на входе в тело, обязано
 * считаться живым и на обратном ребре. Цели переходов — те же индексы, что у раскладки: смещения
 * считает `src/e2k/twoPassLayout.ts`, а носитель несёт готовый номер инструкции.
 */
export function successorsOf(instructions: readonly AsmInstruction[], at: number): number[] {
  const next = at + 1 < instructions.length ? [at + 1] : [];
  const instruction = instructions[at];
  if (instruction === undefined) return next;
  if (instruction.mnemonic === 'IR.jmp' || instruction.mnemonic === 'IR.jmp_if' || instruction.mnemonic === 'IR.jmp_if_not') {
    const offset = instruction.mnemonic === 'IR.jmp' ? instruction.operands[0] : instruction.operands[1];
    if (offset !== undefined && offset.kind === 'imm' && offset.value >= 0 && offset.value < instructions.length) {
      return [...next, offset.value];
    }
  }
  return next;
}

/**
 * Живые на входе и на выходе каждой инструкции — обратный анализ до неподвижной точки.
 *
 * Это то, что просит постановка §2.1, и это же даёт **точную** нижнюю границу числа регистров:
 * максимум `|liveOut|` по потоку.
 */
export function liveSetsOf(instructions: readonly AsmInstruction[]): {
  readonly liveIn: readonly (readonly number[])[];
  readonly liveOut: readonly (readonly number[])[];
} {
  const liveIn = instructions.map(() => new Set<number>());
  const liveOut = instructions.map(() => new Set<number>());
  let changed = true;
  while (changed) {
    changed = false;
    for (let at = instructions.length - 1; at >= 0; at--) {
      const { def, use } = defUseOf(instructions[at]!);
      const out = new Set<number>();
      for (const successor of successorsOf(instructions, at)) {
        for (const vreg of liveIn[successor]!) out.add(vreg);
      }
      const inSet = new Set<number>(use);
      for (const vreg of out) if (!def.includes(vreg)) inSet.add(vreg);
      const same =
        out.size === liveOut[at]!.size &&
        inSet.size === liveIn[at]!.size &&
        [...out].every((vreg) => liveOut[at]!.has(vreg)) &&
        [...inSet].every((vreg) => liveIn[at]!.has(vreg));
      if (!same) {
        liveOut[at] = out;
        liveIn[at] = inSet;
        changed = true;
      }
    }
  }
  return {
    liveIn: liveIn.map((set) => [...set].sort((a, b) => a - b)),
    liveOut: liveOut.map((set) => [...set].sort((a, b) => a - b)),
  };
}

/** Номер регистра-операнда, если он там есть. */
function registerAt(instruction: AsmInstruction, index: number): number | undefined {
  const operand = instruction.operands[index];
  return operand !== undefined && operand.kind === 'reg' ? operand.index : undefined;
}

const registers = (...values: (number | undefined)[]): number[] =>
  values.filter((value): value is number => value !== undefined);

/** Что носитель пишет и читает. Раскладка — `src/e2k/emitterShell.ts:205-298`. */
export function defUseOf(instruction: AsmInstruction): DefUse {
  const operands = instruction.operands;
  switch (instruction.mnemonic) {
    case 'IR.const':
      return { def: registers(registerAt(instruction, 0)), use: [] };
    case 'IR.move':
    case 'IR.not':
      return { def: registers(registerAt(instruction, 0)), use: registers(registerAt(instruction, 1)) };
    case 'IR.jmp':
      return { def: [], use: [] };
    case 'IR.jmp_if':
    case 'IR.jmp_if_not':
      return { def: [], use: registers(registerAt(instruction, 0)) };
    case 'IR.ret': {
      const flag = operands[0];
      const hasValue = flag !== undefined && flag.kind === 'imm' && flag.value === 1;
      return { def: [], use: hasValue ? registers(registerAt(instruction, 1)) : [] };
    }
    case 'IR.call':
    case 'IR.invoke': {
      const flag = operands[0];
      const argc = flag !== undefined && flag.kind === 'imm' ? flag.value >> 1 : 0;
      const hasDestination = flag !== undefined && flag.kind === 'imm' && (flag.value & 1) === 1;
      const use: number[] = [];
      for (let index = 0; index < argc; index++) {
        use.push(...registers(registerAt(instruction, 1 + index)));
      }
      return { def: hasDestination ? registers(registerAt(instruction, 4)) : [], use };
    }
    default:
      // Остальные носители эмиттера — `[d, a, b]` (арифметика, сравнения).
      return {
        def: registers(registerAt(instruction, 0)),
        use: registers(registerAt(instruction, 1), registerAt(instruction, 2)),
      };
  }
}

/** Интервалы жизни и пик одновременной жизни. */
export function liveIntervalsOf(instructions: readonly AsmInstruction[]): Liveness {
  // Интервал — **от первого определения до последнего чтения** (постановка, §2.2). Один vreg —
  // один интервал: переименование значений (SSA) в этом слое не делается, а раскладка обязана
  // выражаться отображением «vreg → регистр» (`applyAllocation`).
  const firstDef = new Map<number, number>();
  const lastUse = new Map<number, number>();
  const touch = (vreg: number, at: number, isUse: boolean): void => {
    if (!firstDef.has(vreg)) firstDef.set(vreg, at);
    if (isUse) lastUse.set(vreg, at);
    else if (!lastUse.has(vreg)) lastUse.set(vreg, at);
  };
  instructions.forEach((instruction, at) => {
    const { def, use } = defUseOf(instruction);
    // Чтение обрабатывается ДО записи: у `IR.move d, a` значение `a` читается раньше, чем пишется
    // `d`, и если это один и тот же vreg, команда обязана попасть в его интервал.
    for (const vreg of new Set(use)) touch(vreg, at, true);
    for (const vreg of new Set(def)) touch(vreg, at, false);
  });

  const intervals: LiveInterval[] = [...firstDef.entries()].map(([vreg, start]) => ({
    vreg,
    start,
    end: lastUse.get(vreg) ?? start,
  }));

  let peak = 0;
  let peakAt = -1;
  for (let at = 0; at < instructions.length; at++) {
    const live = intervals.filter((interval) => interval.start <= at && at <= interval.end).length;
    if (live > peak) {
      peak = live;
      peakAt = at;
    }
  }
  // Точная граница — по живым на выходе каждой инструкции (обратный анализ с переходами):
  // меньше этого числа не обойтись никакой раскладке, даже если каждому отрезку жизни дать свой
  // регистр — в этот момент все они живы одновременно.
  const sets = liveSetsOf(instructions);
  let peakLive = 0;
  let peakLiveAt = -1;
  sets.liveOut.forEach((live, at) => {
    if (live.length > peakLive) {
      peakLive = live.length;
      peakLiveAt = at;
    }
  });
  return { intervals, peak, peakAt, peakLive, peakLiveAt };
}

/**
 * Отрезки жизни: непрерывные участки, на которых vreg жив.
 *
 * Отличаются от интервалов тем, что **рвутся смертью значения**: если vreg переопределён или между
 * двумя чтениями значения нет, регистр на этом промежутке свободен для других значений. Именно это
 * даёт раскладке уложиться, когда интервалов-объединений не хватает.
 */
export function liveSegmentsOf(instructions: readonly AsmInstruction[]): LiveInterval[] {
  const { liveIn, liveOut } = liveSetsOf(instructions);
  const segments: LiveInterval[] = [];
  const open = new Map<number, number>();
  instructions.forEach((instruction, at) => {
    const alive = new Set<number>([...liveIn[at]!, ...liveOut[at]!, ...defUseOf(instruction).def]);
    for (const [vreg, start] of [...open]) {
      if (!alive.has(vreg)) {
        segments.push({ vreg, start, end: at - 1 });
        open.delete(vreg);
      }
    }
    for (const vreg of alive) if (!open.has(vreg)) open.set(vreg, at);
  });
  const last = instructions.length - 1;
  for (const [vreg, start] of open) segments.push({ vreg, start, end: Math.max(start, last) });
  return segments;
}

/**
 * Пересекаются ли интервалы. Соприкосновение на одной команде считается пересечением: если одно
 * значение определяется там, где другое читается, регистр обязан быть разным (иначе чтение
 * получит новое значение).
 */
export function overlaps(a: LiveInterval, b: LiveInterval): boolean {
  return a.start <= b.end && b.start <= a.end;
}
