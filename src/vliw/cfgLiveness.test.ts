/**
 * ОРАКУЛ ЖИВОСТИ ПО ГРАФУ ПОТОКА УПРАВЛЕНИЯ (CFG).
 *
 * # Зачем
 *
 * Раскладка регистров считала жизнь **линейно** — отрезком `[start, end]` по порядку носителей.
 * В цикле это неверно: значение, определённое в теле, живо в **заголовке следующего витка**, а по
 * индексам определение стоит ПОСЛЕ использования. Линейная модель такого не видит вовсе (даёт 0),
 * а слияние отрезков через дугу (`mergeLoopCarriedSegments`) лечило симптом ценой завышения пика
 * (`docs/e2k-regalloc-debt.md` §2, §4).
 *
 * Здесь проверяется точная модель: множества `liveIn`/`liveOut` считаются по графу до неподвижной
 * точки, и по ним же измеряется **точная** нижняя граница числа регистров.
 *
 * # Что проверяется
 *
 * | # | проверка |
 * |---|---|
 * | 1.1 | программа без циклов: множества совпадают с ручным счётом, пик равен линейному пику |
 * | 1.2 | цикл с двумя переменными через дугу: обе живы на входе заголовка, а их определения — на выходе тела |
 * | 1.3 | ветвление: `liveOut` инструкции = объединение `liveIn` преемников (уравнение потока) |
 * | 1.4 | негативный контроль: без учёта обратных дуг те же переменные живыми не считаются |
 *
 * # Чего оракул НЕ доказывает
 *
 * Что раскладка на этих множествах удаётся: это отдельный замер (`docs/e2k-regalloc-debt.md` §3).
 */

import { describe, it, expect } from 'vitest';
import type { AsmInstruction, Operand } from '../e2k/backend';
import { defUseOf, liveSetsOf } from '../e2k/liveness';
import { buildCfg, cfgLiveSets, cfgPressure, cfgRanges } from './cfg';

const imm = (value: number): Operand => ({ kind: 'imm', value });
const reg = (index: number): Operand => ({ kind: 'reg', index });
const carrier = (mnemonic: string, operands: readonly Operand[]): AsmInstruction => ({
  mnemonic,
  channel: 0,
  operands,
});

/** Прямая программа: `v0 = 1; v1 = 2; v2 = v0 + v1; вернуть v2`. */
const STRAIGHT: readonly AsmInstruction[] = [
  carrier('IR.const', [reg(0), imm(1), imm(0)]),
  carrier('IR.const', [reg(1), imm(2), imm(0)]),
  carrier('IR.add', [reg(2), reg(0), reg(1)]),
  carrier('IR.ret', [imm(1), reg(2)]),
];

/**
 * Цикл, у которого **обе** переносимые через дугу переменные определяются в теле, а читаются в
 * заголовке: `v0` и `v3` определены на 4 и 5, прочитаны на 2. Линейная модель (определение → последнее
 * чтение) видит для них ноль жизни: чтение стоит раньше определения.
 *
 * ```
 * 0: const v1 = 1        ; инвариант
 * 2: add   v2 = v0 + v3  ; заголовок: оба значения приходят по обратной дуге
 * 3: jmp_if_not v2 → 6
 * 4: add   v0 = v1 + v1  ; определение v0 в теле
 * 5: mul   v3 = v1 + v1  ; определение v3 в теле
 * 6: jmp   → 1           ; обратная дуга
 * 7: ret   v2            — в потоке индексы 0…6
 * ```
 */
const LOOP_CARRIED: readonly AsmInstruction[] = [
  carrier('IR.const', [reg(1), imm(1), imm(0)]), // 0
  carrier('IR.add', [reg(2), reg(0), reg(3)]), // 1 — заголовок (цель дуги — 1)
  carrier('IR.jmp_if_not', [reg(2), imm(6)]), // 2 — выход из цикла на 6
  carrier('IR.add', [reg(0), reg(1), reg(1)]), // 3 — определение v0 в теле
  carrier('IR.mul', [reg(3), reg(1), reg(1)]), // 4 — определение v3 в теле
  carrier('IR.jmp', [imm(1)]), // 5 — обратная дуга на 1
  carrier('IR.ret', [imm(1), reg(2)]), // 6
];

/** Ветвление с двумя ветками и слиянием: в ветках определяются разные значения, оба нужны после. */
const BRANCH: readonly AsmInstruction[] = [
  carrier('IR.const', [reg(0), imm(1), imm(0)]), // 0
  carrier('IR.jmp_if', [reg(0), imm(4)]), // 1 — ветка B начинается на 4
  carrier('IR.const', [reg(1), imm(2), imm(0)]), // 2 — ветка A
  carrier('IR.jmp', [imm(6)]), // 3 — переход к слиянию
  carrier('IR.const', [reg(2), imm(3), imm(0)]), // 4 — ветка B
  carrier('IR.jmp', [imm(6)]), // 5 — переход к слиянию
  carrier('IR.add', [reg(3), reg(1), reg(2)]), // 6 — слияние: читает v1 и v2
  carrier('IR.ret', [imm(1), reg(3)]), // 7
];

const options = { defUse: defUseOf };

describe('CFG: граф базовых блоков', () => {
  it('блоки выделяются по целям переходов, и у каждого названы преемники и предшественники', () => {
    const cfg = buildCfg(LOOP_CARRIED);
    // Заголовок — цель обратной дуги, тело — всё до перехода.
    expect(cfg.blocks.length).toBeGreaterThanOrEqual(2);
    const header = cfg.blocks.find((block) => block.start === 1)!;
    expect(header.successors.length).toBeGreaterThan(0);
    expect(cfg.predecessors[1]).toContain(5); // обратная дуга ведёт в заголовок
    expect(cfg.successors[5]).toContain(1);
    // Дуга назад: цель перехода МЕНЬШЕ позиции перехода.
    expect(cfg.backEdges.some((edge) => edge.from === 5 && edge.to === 1)).toBe(true);
  });
});

describe('CFG: точная живость (задача 1)', () => {
  it('1.1 программа без циклов: множества по ручному счёту, пик равен линейному', () => {
    const { liveIn, liveOut } = cfgLiveSets(STRAIGHT, options);
    // `v0` жив на 2 (читается там), `v1` — тоже; после `add` живёт `v2` до возврата.
    expect(liveIn[2]).toEqual([0, 1]);
    expect(liveOut[2]).toEqual([2]);
    expect(liveIn[3]).toEqual([2]);
    expect(liveOut[3]).toEqual([]);
    // Пик «занятых значений» на прямой программе совпадает с линейным: 3 на инструкции `add`.
    const pressure = cfgPressure(STRAIGHT, options);
    expect(pressure.peak).toBe(3);
    // Точная граница меньше: приёмник `v2` занимает регистр умирающего чтения (железо читает
    // операнды до записи приёмника).
    expect(pressure.exact).toBe(2);
  });

  it('1.2 цикл с двумя переменными через дугу: обе живы в заголовке, их определения — на выходе тела', () => {
    const { liveIn, liveOut } = cfgLiveSets(LOOP_CARRIED, options);
    // Заголовок (1) читает v0 и v3 — они приходят по обратной дуге, а не по линейному порядку.
    expect(liveIn[1]).toContain(0);
    expect(liveIn[1]).toContain(3);
    // Определения в теле живы на выходе своих инструкций — именно это линейная модель теряет.
    expect(liveOut[3]).toContain(0);
    expect(liveOut[4]).toContain(3);
    // Пик: в заголовке одновременно живы v0, v1, v3 — а переносимых через дугу ровно две.
    const carried = [0, 3].filter((vreg) => liveIn[1]!.includes(vreg));
    expect(carried.length, 'переносимых через дугу').toBe(2);
    const pressure = cfgPressure(LOOP_CARRIED, options);
    expect(pressure.peak).toBeGreaterThanOrEqual(2);
    // Отрезков жизни у переносимых значений — по одному на значение (а не ноль, как у линейной модели).
    const ranges = cfgRanges(LOOP_CARRIED, options);
    for (const vreg of carried) {
      expect(ranges.filter((range) => range.vreg === vreg).length, `отрезки v${vreg}`).toBeGreaterThan(0);
    }
  });

  it('1.3 ветвление: liveOut инструкции = объединение liveIn преемников, liveIn = use ∪ (liveOut − def)', () => {
    for (const program of [STRAIGHT, LOOP_CARRIED, BRANCH]) {
      const cfg = buildCfg(program);
      const { liveIn, liveOut } = cfgLiveSets(program, options);
      program.forEach((instruction, at) => {
        const union = new Set<number>();
        for (const successor of cfg.successors[at]!) for (const vreg of liveIn[successor]!) union.add(vreg);
        expect([...union].sort((a, b) => a - b), `liveOut(${at})`).toEqual([...liveOut[at]!].sort((a, b) => a - b));
        const { def, use } = defUseOf(instruction);
        const expected = new Set<number>(use);
        for (const vreg of liveOut[at]!) if (!def.includes(vreg)) expected.add(vreg);
        expect([...expected].sort((a, b) => a - b), `liveIn(${at})`).toEqual([...liveIn[at]!].sort((a, b) => a - b));
      });
    }
  });

  it('1.3б множества не шире пошагового анализа конвейера и совпадают там, где нет безусловного перехода', () => {
    // Конвейер (`src/e2k/liveness.ts`, `successorsOf`) добавляет падение на следующую инструкцию
    // даже после **безусловного** `IR.jmp`: это консервативно (лишнее ребро → лишняя жизнь), но
    // не точно. Здесь это различие не замалчивается, а проверяется: множества CFG обязаны быть
    // ПОДмножествами конвейерных, а на потоке без безусловных переходов — совпадать в точности.
    const cases: ReadonlyArray<{ name: string; program: readonly AsmInstruction[]; exact: boolean }> = [
      { name: 'прямая', program: STRAIGHT, exact: true },
      { name: 'ветвление', program: BRANCH, exact: true },
      // В цикле есть `IR.jmp` назад: расхождение ожидаемо и названо ниже.
      { name: 'цикл', program: LOOP_CARRIED, exact: false },
    ];
    for (const { name, program, exact } of cases) {
      const mine = cfgLiveSets(program, options);
      const theirs = liveSetsOf(program);
      program.forEach((_instruction, at) => {
        for (const vreg of mine.liveIn[at]!) {
          expect(theirs.liveIn[at], `${name}: liveIn(${at}) ⊇ v${vreg}`).toContain(vreg);
        }
        for (const vreg of mine.liveOut[at]!) {
          expect(theirs.liveOut[at], `${name}: liveOut(${at}) ⊇ v${vreg}`).toContain(vreg);
        }
      });
      if (exact) {
        expect(mine.liveIn.map((set) => [...set]), `${name}: liveIn`).toEqual(
          theirs.liveIn.map((set) => [...set]),
        );
        expect(mine.liveOut.map((set) => [...set]), `${name}: liveOut`).toEqual(
          theirs.liveOut.map((set) => [...set]),
        );
      }
    }
    // Названное расхождение: у цикла конвейер считает `v2` (условие выхода) живым и ПОСЛЕ
    // своего последнего чтения — из-за лишнего ребра 5→6 после безусловного перехода.
    const mineLoop = cfgLiveSets(LOOP_CARRIED, options);
    const theirsLoop = liveSetsOf(LOOP_CARRIED);
    expect(mineLoop.liveOut[5]).not.toContain(2);
    expect(theirsLoop.liveOut[5]).toContain(2);
  });

  it('1.4 негативный контроль: без учёта обратных дуг переносимые значения живыми НЕ считаются', () => {
    const withBackEdges = cfgLiveSets(LOOP_CARRIED, options);
    const without = cfgLiveSets(LOOP_CARRIED, { ...options, ignoreBackEdges: true });
    // Переносимое значение считается живым на выходе СВОЕГО определения: ему предстоит чтение
    // в заголовке на следующем витке. Это и теряет линейная модель.
    const carried = (sets: { liveOut: readonly (readonly number[])[] }): number =>
      [
        [0, 3],
        [3, 4],
      ].filter(([vreg, def]) => sets.liveOut[def]!.includes(vreg!)).length;
    // С дугой живут оба определения — «2, а не 0» из постановки.
    expect(carried(withBackEdges)).toBe(2);
    // Без дуги — ни одно: тот же поток, но жизнь через виток не видна.
    expect(carried(without)).toBe(0);
  });
});
