/**
 * ОРАКУЛ РАСКЛАДКИ РЕГИСТРОВ: LIVE RANGES + LINEAR SCAN.
 *
 * # Зачем
 *
 * Ядро FIR не собирается целиком в QEMU по двум причинам, и первая — регистры: процедуре
 * `фильтр` нужно 17 vreg'ов, а свободно всего **10** регистров `%b[0..9]` — `%b[10..15]` держит
 * рантайм массивов (`src/e2k/arrayRuntime.ts`, `ARRAY_REGISTERS`), а окно больше не расширяется:
 * `setwd` отложен (`docs/e2k-setwd-memory.md`). Значит vreg'и нужно раскладывать по интервалам
 * жизни, а не «vreg = номер регистра».
 *
 * # Что проверяется
 *
 * | проверка | что именно |
 * |---|---|
 * | 1.1 | интервал `[def, последнее чтение]` для каждой vreg |
 * | 1.2 | две одновременно живые vreg получают **разные** регистры |
 * | 1.3 | `фильтр` FIR: раскладка либо удаётся, либо отказывает с числом и списком конфликтующих |
 * | 1.4 | заняты только `%b[0..9]`: регистры рантайма `%b[10..15]` не трогаются |
 * | 1.5 | при нехватке — **отказ с точной причиной**, а не spill и не молчаливая перезапись |
 * | 1.6 | негативный контроль: чтение после конца интервала расширяет интервал |
 *
 * # Источник опр/исп — не догадка
 *
 * Раскладка операндов носителя зафиксирована эмиттером (`src/e2k/emitterShell.ts:205-298`):
 * `IR.const [d, k, type]`, `IR.move [d, a]`, `IR.jmp [off]`, `IR.jmp_if [cond, off]`,
 * `IR.call`/`IR.invoke [flags, arg0, arg1, payload, dst]`, `IR.ret [есть значение, регистр]`,
 * `IR.not [d, a]`, остальные — `[d, a, b]`.
 *
 * # Чего оракул НЕ доказывает
 *
 * Что программа от этого заработает: раскладка меняет **номера регистров**, а не поток команд.
 * Прогон в QEMU — отдельно (`src/e2k/e2kWideQemu.test.ts` и будущий FIR-оракул).
 */

import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { getEncoder, type AsmInstruction, type Operand } from './backend';
import { emitShell } from './emitterShell';
import { annotateAtomRegions } from '../compiler/atomRegions';
import { regModuleOf } from '../vliw/regOracle';
import {
  ALLOCATABLE_REGISTERS,
  RESERVED_REGISTERS,
  allocateRegisters,
  applyAllocation,
} from './regAlloc';
import { defUseOf, liveIntervalsOf } from './liveness';
import { ARRAY_REGISTERS } from './arrayRuntime';

const ROOT = path.resolve(__dirname, '..', '..');
const imm = (value: number): Operand => ({ kind: 'imm', value });
const reg = (index: number): Operand => ({ kind: 'reg', index });

/** Носители для проверок собираются прямо здесь: их раскладка зафиксирована эмиттером. */
const carrier = (mnemonic: string, operands: readonly Operand[]): AsmInstruction => ({
  mnemonic,
  channel: 0,
  operands,
});

/** Программа FIR: носители процедуры `фильтр` (та же дорога, что в понижении). */
function firProcedure(name: string): AsmInstruction[] {
  const source = fs.readFileSync(path.join(ROOT, 'tests', 'dsp', 'kernels', 'fir.osnova'), 'utf-8');
  const built = regModuleOf(source);
  if (built === null) throw new Error('ядро FIR не компилируется');
  const annotated = annotateAtomRegions(built.module, [
    { atom: 'A5', procedures: built.module.procedures.map((procedure) => procedure.name) },
  ]);
  const emitted = emitShell(annotated, getEncoder('internal-shell'));
  const procedures = built.module.procedures;
  const index = procedures.findIndex((procedure) => procedure.name === name);
  if (index < 0) throw new Error(`в FIR нет процедуры ${name}`);
  const from = procedures[index]!.codeOffset;
  const to = index + 1 < procedures.length ? procedures[index + 1]!.codeOffset : emitted.instructions.length;
  return [...emitted.instructions.slice(from, to)];
}

describe('liveness: интервалы жизни', () => {
  it('1.1 интервал = от первого определения до последнего чтения', () => {
    // 0: const v0 = 5
    // 1: move v1 = v0      (v0 читается здесь)
    // 2: const v0 = 7      (v0 переопределён)
    // 3: add  v2 = v1 + v0 (v0 и v1 читаются здесь — последнее чтение обоих)
    const program = [
      carrier('IR.const', [reg(0), imm(5), imm(0)]),
      carrier('IR.move', [reg(1), reg(0)]),
      carrier('IR.const', [reg(0), imm(7), imm(0)]),
      carrier('IR.add', [reg(2), reg(1), reg(0)]),
    ];
    const { intervals } = liveIntervalsOf(program);
    // Постановка §2.2: один интервал на vreg, от первого определения до последнего чтения.
    // Переопределение на шаге 2 интервал НЕ разрывает: переименования значений (SSA) в этом слое
    // нет, и раскладка обязана выражаться отображением «vreg → регистр».
    const byVreg = new Map(intervals.map((interval) => [interval.vreg, interval]));
    expect(byVreg.get(0), 'v0').toEqual({ vreg: 0, start: 0, end: 3 });
    expect(byVreg.get(1), 'v1').toEqual({ vreg: 1, start: 1, end: 3 });
    expect(byVreg.get(2), 'v2').toEqual({ vreg: 2, start: 3, end: 3 });
    expect(intervals.length, 'один интервал на vreg').toBe(3);
  });

  it('1.6 негативный контроль: чтение после «конца» расширяет интервал', () => {
    const before = [carrier('IR.const', [reg(0), imm(1), imm(0)]), carrier('IR.move', [reg(1), reg(0)])];
    const after = [...before, carrier('IR.add', [reg(2), reg(0), reg(1)])];
    const short = liveIntervalsOf(before).intervals.find((interval) => interval.vreg === 0)!;
    const long = liveIntervalsOf(after).intervals.find((interval) => interval.vreg === 0)!;
    expect(short.end, 'до добавления чтения').toBe(1);
    expect(long.end, 'после добавления чтения').toBe(2);
    expect(long.end).toBeGreaterThan(short.end);
  });

  it('опр/исп носителя читаются по раскладке эмиттера', () => {
    expect(defUseOf(carrier('IR.const', [reg(3), imm(0), imm(0)]))).toEqual({ def: [3], use: [] });
    expect(defUseOf(carrier('IR.move', [reg(1), reg(2)]))).toEqual({ def: [1], use: [2] });
    expect(defUseOf(carrier('IR.add', [reg(1), reg(2), reg(3)]))).toEqual({ def: [1], use: [2, 3] });
    expect(defUseOf(carrier('IR.jmp', [imm(4)]))).toEqual({ def: [], use: [] });
    expect(defUseOf(carrier('IR.ret', [imm(1), reg(5)]))).toEqual({ def: [], use: [5] });
    expect(defUseOf(carrier('IR.ret', [imm(0), reg(5)]))).toEqual({ def: [], use: [] });
    // `IR.invoke [flags, arg0, arg1, payload, dst]`: аргументов — flags >> 1, приёмник — при флаге.
    expect(defUseOf(carrier('IR.invoke', [imm(0b101), reg(6), reg(7), imm(0), reg(8)]))).toEqual({
      def: [8],
      use: [6, 7],
    });
    // flags = 0b011: приёмник есть (бит 0), аргументов ОДИН (0b011 >> 1 = 1).
    expect(defUseOf(carrier('IR.invoke', [imm(0b011), reg(6), reg(7), imm(0), reg(8)]))).toEqual({
      def: [8],
      use: [6],
    });
  });
});

describe('linear scan: раскладка по интервалам', () => {
  it('1.2 одновременно живые vreg получают разные регистры', () => {
    // v0 живёт на [0,2], v1 — на [1,2] → они интерферируют.
    const program = [
      carrier('IR.const', [reg(0), imm(1), imm(0)]),
      carrier('IR.const', [reg(1), imm(2), imm(0)]),
      carrier('IR.add', [reg(2), reg(0), reg(1)]),
    ];
    const { intervals } = liveIntervalsOf(program);
    const result = allocateRegisters(intervals);
    expect(result.ok, result.ok ? '' : result.reason).toBe(true);
    if (!result.ok) return;
    expect(result.allocation.assignment.get(0), 'v0').not.toBe(result.allocation.assignment.get(1));
    expect(result.allocation.assignment.get(0)).not.toBe(result.allocation.assignment.get(2));
  });

  it('непересекающиеся интервалы переиспользуют один регистр', () => {
    // v0 живёт на [0,0], v1 — на [1,1] → один регистр на двоих.
    const program = [carrier('IR.const', [reg(0), imm(1), imm(0)]), carrier('IR.const', [reg(1), imm(2), imm(0)])];
    const { intervals } = liveIntervalsOf(program);
    const result = allocateRegisters(intervals);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.allocation.assignment.get(0)).toBe(result.allocation.assignment.get(1));
  });

  it('1.4 заняты только %b[0..9]: регистры рантайма не трогаются', () => {
    const program = Array.from({ length: 12 }, (_, index) => carrier('IR.const', [reg(index), imm(index), imm(0)]));
    // Двенадцать интервалов, но каждый живёт один шаг → все уложатся в один регистр.
    const { intervals } = liveIntervalsOf(program);
    const result = allocateRegisters(intervals);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // Сверка идёт с РАНТАЙМОМ МАССИВОВ, а не с собственной константой раскладки: иначе проверка
    // сверяла бы константу сама с собой, и захват `%b[10]` прошёл бы незамеченным (реестр
    // проверяемости, случай 14 — ожидание, выведенное из проверяемого же места).
    const runtimeRegisters = Object.values(ARRAY_REGISTERS);
    for (const physical of result.allocation.assignment.values()) {
      expect(ALLOCATABLE_REGISTERS, `регистр %b[${physical}] вне разрешённых`).toContain(physical);
      expect(runtimeRegisters, `регистр %b[${physical}] занят рантаймом массивов`).not.toContain(physical);
      expect(physical, `регистр %b[${physical}] вне окна`).toBeLessThan(16);
    }
    expect(ALLOCATABLE_REGISTERS.length, 'свободных регистров ровно десять').toBe(10);
    for (const register of ALLOCATABLE_REGISTERS) {
      expect(runtimeRegisters, `%b[${register}] отдан и рантайму, и раскладке`).not.toContain(register);
    }
  });

  it('1.5 нехватка регистров — отказ с числом и списком конфликтующих vreg', () => {
    // Одиннадцать интервалов, живущих ОДНОВРЕМЕННО: десять регистров их не вмещают.
    const program: AsmInstruction[] = [];
    for (let index = 0; index < 11; index++) program.push(carrier('IR.const', [reg(index), imm(index), imm(0)]));
    // Одиннадцатое чтение всех одиннадцати — держит все интервалы живыми до конца.
    program.push(
      carrier('IR.add', [reg(20), reg(0), reg(1)]),
      carrier('IR.add', [reg(20), reg(2), reg(3)]),
      carrier('IR.add', [reg(20), reg(4), reg(5)]),
      carrier('IR.add', [reg(20), reg(6), reg(7)]),
      carrier('IR.add', [reg(20), reg(8), reg(9)]),
      carrier('IR.add', [reg(20), reg(10), reg(0)]),
    );
    const { intervals } = liveIntervalsOf(program);
    const result = allocateRegisters(intervals);
    expect(result.ok, 'отказ обязателен: одновременно живых больше десяти').toBe(false);
    if (result.ok) return;
    expect(result.reason, 'в причине нет числа конфликтующих').toMatch(/одновременно/);
    expect(result.conflicts.length, 'список конфликтующих пуст').toBeGreaterThan(0);
  });
});

describe('раскладка FIR: 17 vreg в 10 свободных регистров', () => {
  const filter = firProcedure('фильтр');
  const liveness = liveIntervalsOf(filter);

  it('измерено: интервалов 17 (по одному на vreg), пик одновременной жизни 13', () => {
    // Это измерение, а не ожидание: оно и решает, влезает ли 17 vreg'ов в 10 регистров.
    expect(liveness.intervals.length, 'интервалов у фильтра — по одному на vreg').toBe(17);
    expect(liveness.peak, 'пик одновременно живых — больше десяти свободных').toBe(13);
  });

  it('1.3 раскладка либо удаётся, либо отказ называет причину и конфликты', () => {
    const result = allocateRegisters(liveness.intervals);
    if (result.ok) {
      // Удалась — проверяем, что она действительно корректна.
      for (const physical of result.allocation.assignment.values()) {
        expect(ALLOCATABLE_REGISTERS).toContain(physical);
      }
      const byRegister = new Map<number, number[]>();
      for (const [vreg, physical] of result.allocation.assignment) {
        byRegister.set(physical, [...(byRegister.get(physical) ?? []), vreg]);
      }
      for (const [physical, vregs] of byRegister) {
        for (let i = 0; i < vregs.length; i++) {
          for (let j = i + 1; j < vregs.length; j++) {
            const first = liveness.intervals.filter((interval) => interval.vreg === vregs[i]!);
            const second = liveness.intervals.filter((interval) => interval.vreg === vregs[j]!);
            for (const a of first) {
              for (const b of second) {
                const overlap = a.start <= b.end && b.start <= a.end;
                expect(overlap, `%b[${physical}]: v${vregs[i]} и v${vregs[j]} живут одновременно`).toBe(false);
              }
            }
          }
        }
      }
      return;
    }
    // Отказ обязан быть объяснён: сколько одновременно живых и какие именно vreg.
    expect(result.reason, 'в причине нет числа одновременно живых').toMatch(/одновременно/);
    expect(result.conflicts.length, 'в отказе нет списка конфликтующих vreg').toBeGreaterThan(0);
    expect(result.conflicts.every((vreg) => Number.isInteger(vreg))).toBe(true);
  });

  it('4.2 раскладка применяется к носителям: номера регистров заменяются', () => {
    const allocation = new Map<number, number>([
      [0, 3],
      [5, 7],
    ]);
    const applied = applyAllocation([carrier('IR.move', [reg(0), reg(5)]), carrier('IR.const', [reg(9), imm(1), imm(0)])], allocation);
    expect(applied.instructions[0]!.operands[0]).toEqual(reg(3));
    expect(applied.instructions[0]!.operands[1]).toEqual(reg(7));
    // Не отображённая vreg остаётся как есть — но это видно, а не молчание: функция обязана
    // возвращать список неотображённых в отдельном поле.
    expect(applied.instructions[1]!.operands[0]).toEqual(reg(9));
    expect(applied.unmapped, 'неотображённые названы').toEqual([9]);
  });
});
