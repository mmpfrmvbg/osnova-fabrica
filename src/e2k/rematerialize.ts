/**
 * ПОВТОРНАЯ МАТЕРИАЛИЗАЦИЯ КОНСТАНТ: значение не держим в регистре, а выдаём заново у чтения.
 *
 * # Зачем
 *
 * Раскладка упирается не в число vreg'ов, а в число ОДНОВРЕМЕННО ЖИВЫХ значений: константа, определённая
 * в начале процедуры и прочитанная в конце, держит регистр на всём промежутке. `IR.const` понижается в
 * литерал, значение постоянно — значит его можно выдать заново у каждого чтения.
 *
 * # Правило (звуковое)
 *
 * Материализуется ОДНО определение, а не «vreg вообще»:
 *
 * 1. чтения определения — те, что лежат между ним и **следующим определением того же vreg** (значение
 *    живёт до переопределения; так же считает живость, `src/e2k/liveness.ts`);
 * 2. если таких чтений меньше двух — определение остаётся: одна команда дешевле двух;
 * 3. если между определением и последним его чтением есть **цель перехода** или **сам переход** —
 *    отказ: на чтение можно прийти путём, где это определение не исполнялось, а переопределение успело
 *    (то же правило и та же причина, что у устранения копий, случай 17 реестра проверяемости);
 * 4. определение-цель перехода не убирается — иначе цель исчезла бы из потока.
 *
 * # Чего здесь нет
 *
 * Нет материализации вычисляемых значений (нужно доказывать, что выражение пересчитывается из живых) и
 * нет анализа доминирования: вместо него — то же консервативное правило границ блоков, что уже принято
 * в проекте (устранение копий).
 *
 * # Ошибка, из-за которой правило переписано
 *
 * Первая редакция материализовала «vreg целиком» и отказывалась, если vreg переопределялся ГДЕ УГОДНО
 * в процедуре, — в ядрах DSP такие vreg'и есть все, и она не материализовала ничего. А замер, на
 * котором было построено обещание «7 регистров вместо 10» (`.tmp/shrink-filter.ts`), оказался моделью
 * **не того**: он выбрасывал отрезки всех vreg'ов, которые где-то определялись константой, — вместе с
 * отрезками, определёнными пересылками. Это не материализация, а «делаем вид, что этих регистров нет».
 * Правильный замер — реализация; итог в `docs/e2k-opcodes-real.md` §7.12.
 */

import type { AsmInstruction, Operand } from './backend';
import { defUseOf } from './liveness';
import { blockStartsOf } from './copyElim';

/** Итог материализации. */
export interface Rematerialization {
  readonly instructions: readonly AsmInstruction[];
  /** Сколько копий-определений добавлено. */
  readonly inserted: number;
  /** Сколько исходных определений убрано. */
  readonly removed: number;
  /** vreg'и, у которых определение перестало жить долго. */
  readonly materialized: readonly number[];
  /**
   * Куда переехал каждый входной индекс: `indexOf[старый] = новый`.
   *
   * Нужно вызывающему, чтобы пересчитать **цели переходов**: копии вставляются, то есть индексы
   * СДВИГАЮТСЯ ВВЕРХ, а не только вниз (устранение копий умеет только вниз).
   */
  readonly indexOf: readonly number[];
  /** Сколько определений отклонено правилом и почему — по категориям. */
  readonly skipped: Readonly<Record<'одночтение' | 'границаблока' | 'цельперехода' | 'нетпричины', number>>;
}

const JUMPS = new Set(['IR.jmp', 'IR.jmp_if', 'IR.jmp_if_not']);

/** Индексы всех определений каждого vreg'а (любой мнемоникой — значение меняется). */
function definitionIndices(instructions: readonly AsmInstruction[]): Map<number, number[]> {
  const definitions = new Map<number, number[]>();
  instructions.forEach((instruction, index) => {
    for (const vreg of defUseOf(instruction).def) {
      definitions.set(vreg, [...(definitions.get(vreg) ?? []), index]);
    }
  });
  return definitions;
}

/**
 * Размножить определения констант по их чтениям.
 *
 * @param instructions срез процедуры
 * @param options.codeOffset смещение среза в потоке модуля: цели переходов записаны **индексами
 *   потока модуля** (см. `src/e2k/copyElim.ts`), поэтому приводятся к локальным индексам
 * @param options.blockStarts начала базовых блоков в локальных индексах; по умолчанию считается из
 *   переходов (цель + путь «мимо» условного перехода)
 */
export function rematerializeConstants(
  instructions: readonly AsmInstruction[],
  options: { readonly blockStarts?: readonly number[]; readonly codeOffset?: number } = {},
): Rematerialization {
  const codeOffset = options.codeOffset ?? 0;
  const definitions = definitionIndices(instructions);
  const targets = new Set<number>();
  instructions.forEach((instruction) => {
    if (!JUMPS.has(instruction.mnemonic)) return;
    const targetAt = instruction.mnemonic === 'IR.jmp' ? 0 : 1;
    const operand = instruction.operands[targetAt];
    if (operand === undefined || operand.kind !== 'imm') return;
    const local = operand.value - codeOffset;
    if (local >= 0 && local < instructions.length) targets.add(local);
  });
  const starts = options.blockStarts ?? blockStartsOf(instructions, codeOffset).starts ?? [];
  const skipped = { одночтение: 0, границаблока: 0, цельперехода: 0, нетпричины: 0 } as Record<
    'одночтение' | 'границаблока' | 'цельперехода' | 'нетпричины',
    number
  >;

  const insertBefore = new Map<number, AsmInstruction[]>();
  const dropped = new Set<number>();
  const materialized: number[] = [];
  instructions.forEach((instruction, index) => {
    if (instruction.mnemonic !== 'IR.const' || defUseOf(instruction).def.length !== 1) return;
    const vreg = defUseOf(instruction).def[0]!;
    const own = definitions.get(vreg) ?? [];
    const next = own.find((at) => at > index);
    const limit = next ?? instructions.length;
    const reads: number[] = [];
    for (let at = index + 1; at < limit; at++) {
      if (defUseOf(instructions[at]!).use.includes(vreg)) reads.push(at);
    }
    if (reads.length < 2) {
      skipped['одночтение']++;
      return;
    }
    const last = reads[reads.length - 1]!;
    // Само определение — ЦЕЛЬ ПЕРЕХОДА: убрать нельзя, цель исчезла бы из потока. Начало процедуры
    // целью не считается: на него приходят все пути, и определение на входе исполняется всегда.
    if (targets.has(index)) {
      skipped['цельперехода']++;
      return;
    }
    if (starts.some((start) => start > index && start <= last)) {
      skipped['границаблока']++;
      return;
    }
    let jumpInside = false;
    for (let at = index + 1; at < last; at++) if (JUMPS.has(instructions[at]!.mnemonic)) jumpInside = true;
    if (jumpInside) {
      skipped['границаблока']++;
      return;
    }
    for (const at of reads) insertBefore.set(at, [...(insertBefore.get(at) ?? []), instruction]);
    dropped.add(index);
    materialized.push(vreg);
  });

  const identity = instructions.map((_, index) => index);
  if (dropped.size === 0 && insertBefore.size === 0) {
    return { instructions, inserted: 0, removed: 0, materialized: [], indexOf: identity, skipped };
  }
  const result: AsmInstruction[] = [];
  // Карта «входной индекс → выходной индекс», по одному значению на входной носитель; `-1` — снят
  // (или, для вставленных копий, входа нет вовсе).
  const fullIndexOf: number[] = new Array<number>(instructions.length).fill(-1);
  let inserted = 0;
  instructions.forEach((instruction, index) => {
    const copies = insertBefore.get(index);
    if (copies !== undefined) {
      for (const copy of copies) {
        result.push(copy);
        inserted++;
      }
    }
    if (dropped.has(index)) return;
    fullIndexOf[index] = result.length;
    result.push(instruction);
  });
  return {
    instructions: result,
    inserted,
    removed: dropped.size,
    materialized: [...materialized].sort((a, b) => a - b),
    indexOf: fullIndexOf,
    skipped,
  };
}

/** Операнды-регистры носителя (для проверок в оракуле). */
export function registerOperands(instruction: AsmInstruction): readonly Operand[] {
  return instruction.operands.filter((operand) => operand.kind === 'reg');
}
