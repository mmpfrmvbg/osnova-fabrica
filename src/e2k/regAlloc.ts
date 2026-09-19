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
import { overlaps, type LiveInterval } from './liveness';

/** Свободные регистры раскладки: `%b[0..9]`. */
export const ALLOCATABLE_REGISTERS: readonly number[] = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9];

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
 */
export function allocateRegisters(
  intervals: readonly LiveInterval[],
  free: readonly number[] = ALLOCATABLE_REGISTERS,
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
        usedRegisters.delete(active[index]!.register);
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
          `интервалов (v${interval.vreg} и ещё ${interferes.length} пересекающихся); ` +
          'вытеснение в память (spill) здесь не делается — это следующий слой',
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

/** Соприкасается ли новый интервал с уже разложенным (для списка конфликтов). */
function assignmentsOverlap(candidate: LiveInterval, other: LiveInterval, assignment: ReadonlyMap<number, number>): boolean {
  return assignment.has(candidate.vreg) && assignment.has(other.vreg) && overlaps(candidate, other);
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
): ApplyResult {
  const unmapped = new Set<number>();
  const mapped = instructions.map((instruction) => {
    const operands: Operand[] = instruction.operands.map((operand) => {
      if (operand.kind !== 'reg') return operand;
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
