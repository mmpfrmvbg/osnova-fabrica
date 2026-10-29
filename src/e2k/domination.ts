/**
 * СТОРОЖ ДОМИНИРОВАНИЯ: значение, переносимое через переход, обязано лежать в клетке, которую цель прочтёт.
 *
 * # Зачем отдельный сторож, если есть `mergeLoopCarriedSegments`
 *
 * `src/e2k/liveness.ts#mergeLoopCarriedSegments` сшивает отрезки жизни, переносящие значение через дугу, —
 * и до среза 5г делал это для ПРЯМОЙ дуги только тогда, когда ЦЕЛЬ ЧИТАЕТ vreg **на самой целевой
 * команде** (`defUseOf(targetInstruction).use`). Это не тот же самое, что «значение нужно на цели»:
 * переменная, определённая ВНУТРИ ветви и прочитанная ПОСЛЕ неё (случай 60 реестра, срез 5г), цели
 * не читает — и остаётся разъехавшейся на две клетки. Программа собирается, отказов ноль, число
 * неверное: проба E даёт **107** при эталоне 100, и утечка РАВНА первому терму (`а` = 7).
 *
 * # Инвариант (D4: сторож раньше причины)
 *
 * Для КАЖДОГО перехода `at → target` (и вперёд, и назад) и КАЖДОГО vreg, ЖИВОГО НА ВХОДЕ ЦЕЛИ
 * (`liveIn[target]` по графу — не «используемого целевой командой»):
 *
 *   существует ОДИН отрезок этого vreg, накрывающий и переход, и цель.
 *
 * Иначе значение, пришедшее по дуге, лежит не в той клетке, которую цель прочтёт: либо его разъехавшиеся
 * отрезки получили разные регистры, либо клетку занял кто-то другой. Правило сформулировано ДЛЯ ЛЮБОГО
 * vreg, а не для результата сравнения: иначе следующий случай назывался бы «переменная, не связанная с
 * конъюнкцией, читается после ветви».
 *
 * # Чего сторож НЕ делает
 *
 * Он не чинит и ничего не меняет в раскладке — он читает те же структуры, что и раскладка
 * (`cfgSegmentsOf` → `mergeLoopCarriedSegments` → `cfgLiveSets`), и называет место, vreg и отрезки.
 * Живость берётся по ГРАФУ (`src/vliw/cfg.ts`), как в `src/e2k/regAlloc.ts#allocateProgram`: линейная
 * живость в цикле неверна, а сторожа обязаны спрашивать то же, что спрашивает раскладка.
 */
import type { AsmInstruction } from './backend';
import { cfgSegmentsOf, defUseOf, mergeLoopCarriedSegments, type LiveInterval } from './liveness';
import { cfgLiveSets } from '../vliw/cfg';

/** Переход с готовой целью: `at` — индекс перехода, `target` — индекс цели (в ЭТОМ потоке). */
export interface JumpEdge {
  readonly at: number;
  readonly target: number;
  readonly mnemonic: string;
}

/**
 * Все переходы потока с целью в пределах потока.
 *
 * Цель-«следующая команда» (`target === at + 1`) пропускается: между переходом и целью ничего не стоит,
 * и переносить нечего. Цели за пределами потока пропускаются тоже — это дефект другого сторожа
 * (`src/e2k/regAllocCoverage.test.ts` ловит непересчитанные цели по имени).
 */
export function jumpEdgesOf(instructions: readonly AsmInstruction[]): readonly JumpEdge[] {
  const edges: JumpEdge[] = [];
  instructions.forEach((instruction, at) => {
    if (
      instruction.mnemonic !== 'IR.jmp' &&
      instruction.mnemonic !== 'IR.jmp_if' &&
      instruction.mnemonic !== 'IR.jmp_if_not'
    ) {
      return;
    }
    const operand = instruction.mnemonic === 'IR.jmp' ? instruction.operands[0] : instruction.operands[1];
    if (operand === undefined || operand.kind !== 'imm') return;
    const target = operand.value;
    if (target < 0 || target >= instructions.length || target === at + 1) return;
    edges.push({ at, target, mnemonic: instruction.mnemonic });
  });
  return edges;
}

/** Нарушение доминирования: значение переносится через переход, но одной клетки у него нет. */
export interface DominationViolation {
  readonly at: number;
  readonly target: number;
  readonly mnemonic: string;
  readonly vreg: number;
  /** Дуга назад (цикл) или вперёд (пропущенное тело ветви). */
  readonly backward: boolean;
  /** Отрезки этого vreg ПОСЛЕ слияния — по ним видно, что значение разъехалось. */
  readonly segments: readonly LiveInterval[];
}

/**
 * Сторож: нарушения инварианта доминирования в потоке. Пустой список — значение переносится в одной клетке
 * для каждого живого на цели vreg.
 */
export function dominationViolations(instructions: readonly AsmInstruction[]): readonly DominationViolation[] {
  const merged = mergeLoopCarriedSegments(cfgSegmentsOf(instructions).segments, instructions, 0);
  const liveIn = cfgLiveSets(instructions, { defUse: defUseOf }).liveIn;
  const byVreg = new Map<number, LiveInterval[]>();
  for (const segment of merged) {
    const list = byVreg.get(segment.vreg);
    if (list === undefined) byVreg.set(segment.vreg, [segment]);
    else list.push(segment);
  }
  const violations: DominationViolation[] = [];
  for (const edge of jumpEdgesOf(instructions)) {
    const low = Math.min(edge.at, edge.target);
    const high = Math.max(edge.at, edge.target);
    for (const vreg of liveIn[edge.target] ?? []) {
      const segments = byVreg.get(vreg) ?? [];
      const covered = segments.some((segment) => segment.start <= low && segment.end >= high);
      if (covered) continue;
      violations.push({ ...edge, vreg, backward: edge.target < edge.at, segments });
    }
  }
  return violations;
}

/** Сколько отрезков у каждого vreg: `до` и `после` слияния — для отчёта об аудите. */
export function segmentCounts(instructions: readonly AsmInstruction[]): {
  readonly raw: ReadonlyMap<number, number>;
  readonly merged: ReadonlyMap<number, number>;
} {
  const raw = cfgSegmentsOf(instructions).segments;
  const merged = mergeLoopCarriedSegments(raw, instructions, 0);
  const count = (segments: readonly LiveInterval[]): Map<number, number> => {
    const counts = new Map<number, number>();
    for (const segment of segments) counts.set(segment.vreg, (counts.get(segment.vreg) ?? 0) + 1);
    return counts;
  };
  return { raw: count(raw), merged: count(merged) };
}
