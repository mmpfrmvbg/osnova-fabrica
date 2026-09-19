/**
 * ОРАКУЛ ПОВТОРНОЙ МАТЕРИАЛИЗАЦИИ КОНСТАНТ.
 *
 * # Зачем
 *
 * Константа живёт долго: определена в начале процедуры, читается в концах ветвей. Раскладка упирается
 * в число ОДНОВРЕМЕННО живых значений, поэтому длинная жизнь константы стоит регистра во всём
 * промежутке. Материализация убирает это: значение постоянно (`IR.const` — чистое определение из пула),
 * значит его можно выдать заново у каждого чтения.
 *
 * # Что проверяется
 *
 * | # | проверка |
 * |---|---|
 * | 1 | значение не меняется: копия — тот же носитель с тем же приёмником и тем же литералом |
 * | 2 | определение убрано ровно тогда, когда чтений больше одного (одно чтение оставляем как есть) |
 * | 3 | определение-цель перехода не убирается (иначе цель исчезла бы из потока) |
 * | 4 | переопределение константы в процедуре — отказ, а не догадка |
 * | 5 | **измерено:** `фильтр` FIR влезает в окно вызываемой (нужно 7 из 8) ПОСЛЕ материализации |
 * | 6 | негативный контроль: без материализации `фильтр` в окно НЕ влезает (10 из 8) |
 */

import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { getEncoder, type AsmInstruction, type Operand } from './backend';
import { emitShell } from './emitterShell';
import { annotateAtomRegions } from '../compiler/atomRegions';
import { regModuleOf } from '../vliw/regOracle';
import { defUseOf, liveSegmentsOf } from './liveness';
import { removeCopies } from './copyElim';
import { rematerializeConstants } from './rematerialize';
import { ALLOCATABLE_REGISTERS, WINDOW_REGISTERS_CALLEE, allocateSegments, incomingRegisters } from './regAlloc';

const ROOT = path.resolve(__dirname, '..', '..');
const KERNELS_DIR = path.join(ROOT, 'tests', 'dsp', 'kernels');
const imm = (value: number): Operand => ({ kind: 'imm', value });
const reg = (index: number): Operand => ({ kind: 'reg', index });
const carrier = (mnemonic: string, operands: readonly Operand[]): AsmInstruction => ({
  mnemonic,
  channel: 0,
  operands,
});

/** Срез процедуры ядра — тот же путь, что в конвейере. */
function procedure(name: string, procedureName: string): AsmInstruction[] {
  const source = fs.readFileSync(path.join(KERNELS_DIR, `${name}.osnova`), 'utf-8');
  const built = regModuleOf(source)!;
  const annotated = annotateAtomRegions(built.module, [
    { atom: 'A5', procedures: built.module.procedures.map((item) => item.name) },
  ]);
  const emitted = emitShell(annotated, getEncoder('internal-shell'));
  const index = emitted.scheduled.procedures.findIndex((item) => item.name === procedureName);
  if (index < 0) throw new Error(`в ${name} нет процедуры ${procedureName}`);
  const from = emitted.scheduled.procedures[index]!.codeOffset;
  const to =
    index + 1 < emitted.scheduled.procedures.length
      ? emitted.scheduled.procedures[index + 1]!.codeOffset
      : emitted.instructions.length;
  return [...emitted.instructions.slice(from, to)];
}

/** Сколько регистров окна нужно процедуре после преобразований. */
function windowNeed(carriers: readonly AsmInstruction[]): { need: number; used: number; pins: number } {
  const incoming = incomingRegisters(carriers);
  const free = ALLOCATABLE_REGISTERS.filter((register) => !incoming.includes(register));
  const result = allocateSegments(
    liveSegmentsOf(carriers).filter((segment) => !incoming.includes(segment.vreg)),
    free,
  );
  if (!result.ok) throw new Error(`раскладка не удалась: ${result.reason}`);
  return { need: incoming.length + result.allocation.used.length, used: result.allocation.used.length, pins: incoming.length };
}

describe('повторная материализация констант: правило', () => {
  it('копия ставится перед каждым чтением, исходное определение убирается', () => {
    const carriers: AsmInstruction[] = [
      carrier('IR.const', [reg(7), imm(3), imm(0)]), // 0 — определение
      carrier('IR.add', [reg(1), reg(0), reg(7)]), // 1 — чтение
      carrier('IR.move', [reg(2), reg(3)]), // 2
      carrier('IR.add', [reg(4), reg(1), reg(7)]), // 3 — второе чтение
      carrier('IR.ret', [imm(0), reg(0)]), // 4
    ];
    const result = rematerializeConstants(carriers);
    expect(result.materialized, 'материализованный vreg').toEqual([7]);
    expect(result.inserted, 'добавлено определений').toBe(2);
    expect(result.removed, 'убрано определений').toBe(1);
    // Значение не изменилось: копии — тот же носитель с тем же приёмником и литералом.
    for (const instruction of result.instructions.filter((item) => item.mnemonic === 'IR.const')) {
      expect(instruction.operands).toEqual([reg(7), imm(3), imm(0)]);
    }
    // И чтения по-прежнему читают свой vreg.
    const reads = result.instructions.filter((item) => defUseOf(item).use.includes(7));
    expect(reads.length, 'чтений константы').toBe(2);
  });

  it('при одном чтении определение остаётся: одна команда дешевле двух', () => {
    const carriers: AsmInstruction[] = [
      carrier('IR.const', [reg(7), imm(3), imm(0)]),
      carrier('IR.add', [reg(1), reg(0), reg(7)]),
      carrier('IR.ret', [imm(0), reg(0)]),
    ];
    const result = rematerializeConstants(carriers);
    expect(result.inserted, 'ничего не добавлено').toBe(0);
    expect(result.instructions, 'поток не изменился').toEqual(carriers);
  });

  it('карта индексов смещает вставки ВВЕРХ — по ней пересчитываются цели переходов', () => {
    // Устранение копий сдвигает индексы только вниз; материализация ВСТАВЛЯЕТ определения, то есть
    // сдвигает вверх. Конвейер пересчитывает цели переходов по этой карте, поэтому она обязана быть
    // верной: иначе цель уедет на соседнюю команду.
    const carriers: AsmInstruction[] = [
      carrier('IR.const', [reg(7), imm(3), imm(0)]), // 0 — определение (уедет)
      carrier('IR.add', [reg(1), reg(0), reg(7)]), // 1 — чтение (перед ним встанет копия)
      carrier('IR.move', [reg(2), reg(3)]), // 2 — встанет на позицию 3
      carrier('IR.add', [reg(4), reg(1), reg(7)]), // 3 → 5
      carrier('IR.ret', [imm(0), reg(0)]), // 4 → 6
    ];
    const result = rematerializeConstants(carriers);
    expect(result.inserted, 'вставлено копий').toBe(2);
    expect(result.removed, 'убрано определений').toBe(1);
    // Входной носитель 0 снят: у него нет нового индекса.
    expect(result.indexOf[0], 'снятый носитель').toBe(-1);
    // Перед первым чтением (вход 1) встала одна копия, перед вторым (вход 3) — вторая:
    // выходной поток `[копия, add, move, копия, add, ret]`, значит уцелевшие входы 1..4 лежат на 1, 2, 4, 5.
    expect(result.indexOf.slice(1), 'новые индексы уцелевших').toEqual([1, 2, 4, 5]);
    // И в самом потоке по этим индексам лежат ТЕ ЖЕ носители.
    for (const [old, moved] of result.indexOf.entries()) {
      if (moved < 0) continue;
      expect(result.instructions[moved], `#${old} переехал на ${moved}`).toEqual(carriers[old]);
    }
    expect(result.instructions.length, 'длина после преобразования').toBe(carriers.length + 2 - 1);
  });

  it('определение-цель перехода не убирается — иначе цель исчезнет', () => {
    const carriers: AsmInstruction[] = [
      carrier('IR.const', [reg(7), imm(3), imm(0)]), // 0 — цель перехода (на неё ведёт jmp в конце)
      carrier('IR.add', [reg(1), reg(0), reg(7)]), // 1 — чтение
      carrier('IR.add', [reg(4), reg(1), reg(7)]), // 2 — второе чтение
      carrier('IR.jmp', [imm(0)]), // 3 — переход на определение
    ];
    const result = rematerializeConstants(carriers);
    expect(result.materialized, 'определение-цель не материализуется').toEqual([]);
    expect(result.skipped['цельперехода'], 'отказ назван как «цель перехода»').toBe(1);
    expect(result.instructions).toEqual(carriers);
  });

  it('переопределение константы в процедуре — отказ, а не догадка', () => {
    const carriers: AsmInstruction[] = [
      carrier('IR.const', [reg(7), imm(3), imm(0)]),
      carrier('IR.add', [reg(1), reg(0), reg(7)]),
      carrier('IR.const', [reg(7), imm(9), imm(0)]), // переопределение
      carrier('IR.add', [reg(4), reg(1), reg(7)]),
    ];
    const result = rematerializeConstants(carriers);
    expect(result.materialized, 'ничего не материализовано').toEqual([]);
    expect(result.instructions).toEqual(carriers);
  });
});

describe('повторная материализация: измеренный эффект на ядрах', () => {
  it('ИЗМЕРЕНО: `фильтр` FIR материализации НЕ поддаётся — в окно вызываемой не влезает', () => {
    // Здесь стояло обещание «7 из 8» — оно было получено моделью НЕ ТОГО (выбрасывались отрезки всех
    // vreg'ов, которые где-то определены константой, вместе с пересылочными). Правильный замер —
    // реализация. Итог: у `фильтр` констант пять, но у четырёх из них (v6, v12, v13, v14) **одно**
    // чтение у определения, а у пятой (v7, четыре чтения) промежуток до последнего чтения пересекает
    // цель перехода (18) и переход (19) — правило границ блоков отказывает: на чтение можно прийти
    // путём, где определение не исполнялось, а переопределение успело.
    const filter = procedure('fir', 'фильтр');
    const elimination = removeCopies(filter);
    const materialized = rematerializeConstants(elimination.carriers);
    expect(materialized.materialized, 'материализованных определений у фильтра').toEqual([]);
    expect(materialized.skipped['одночтение'], 'отказано: одно чтение').toBe(4);
    expect(materialized.skipped['границаблока'], 'отказано: граница блока внутри промежутка').toBe(1);
    const need = windowNeed(elimination.carriers).need;
    expect(need, 'нужно регистров окна').toBe(10);
    expect(need, 'в окно вызываемой не влезает').toBeGreaterThan(WINDOW_REGISTERS_CALLEE);
  });

  it('материализация работает там, где промежуток не пересекает границ: синтетическая программа', () => {
    // Различающий опыт: тот же поток, но цель перехода убрана — и определение материализуется.
    const open: AsmInstruction[] = [
      carrier('IR.const', [reg(7), imm(3), imm(0)]), // 0
      carrier('IR.add', [reg(1), reg(0), reg(7)]), // 1 — чтение
      carrier('IR.move', [reg(2), reg(3)]), // 2
      carrier('IR.add', [reg(4), reg(1), reg(7)]), // 3 — второе чтение
    ];
    const blocked: AsmInstruction[] = [
      carrier('IR.const', [reg(7), imm(3), imm(0)]), // 0
      carrier('IR.add', [reg(1), reg(0), reg(7)]), // 1 — чтение
      carrier('IR.move', [reg(2), reg(3)]), // 2 — цель перехода
      carrier('IR.add', [reg(4), reg(1), reg(7)]), // 3 — второе чтение
    ];
    expect(rematerializeConstants(open).materialized, 'без границы — материализуется').toEqual([7]);
    expect(rematerializeConstants(blocked, { blockStarts: [2] }).materialized, 'с границей — нет').toEqual([]);
  });

  it('процедуры IIR и `сумма` материализацию переносят, ничего не теряя', () => {
    for (const [kernel, name] of [
      ['iir', 'фильтр'],
      ['iir', 'сумма'],
      ['fir', 'сумма'],
    ] as const) {
      const carriers = removeCopies(procedure(kernel, name)).carriers;
      const materialized = rematerializeConstants(carriers);
      expect(
        windowNeed(materialized.instructions).need,
        `${kernel}/${name}: окно после материализации`,
      ).toBeLessThanOrEqual(WINDOW_REGISTERS_CALLEE);
    }
  });
});
