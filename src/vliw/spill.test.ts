/**
 * ОРАКУЛ МИНИМАЛЬНОГО ВЫТЕСНЕНИЯ В ПАМЯТЬ (spill).
 *
 * # Зачем
 *
 * Три процедуры пяти ядер не влезают в бюджет точки входа: `fir/фильтр` — 9 живых отрезков при 8
 * свободных, `convolution/свёртка` — 9 при 8, `correlation/корреляция` — 11 при 8
 * (`docs/e2k-regalloc-debt.md` §13). Живость по графу потока управления пик снизила (у `фильтр`
 * линейный 11 → CFG-занятых 10 → CFG-точных 9), но отказ не сняла: отрезки позиционные, а
 * переносимое через дугу цикла значение обязано жить в одном регистре.
 *
 * Здесь проверяется **минимальное** вытеснение: не полный аллокатор с вытеснением, а правило
 * «не хватило регистра → самое дешёвое значение уезжает в память, не больше двух на процедуру».
 *
 * # Что именно утверждается
 *
 * | проверка | что утверждает |
 * |---|---|
 * | 1.1 | девять живых значений при восьми свободных регистрах: раскладка **удаётся**, вытеснений не больше двух, **исполнение** даёт верное число |
 * | 1.2 | если вытеснений нужно больше двух — **отказ с причиной**, а не тихая потеря значения |
 * | 1.3 | эталонный источник FIR (тот, которым измерен 181) вытеснения **не получает** — его поток не меняется |
 * | 1.4 | негативный контроль: без вытеснения та же программа раскладку **не проходит** (иначе 1.1 ничего не доказывает) |
 *
 * Исполнение — на маленькой модели, которая знает ровно те команды, из которых состоит вытеснение
 * (`movtd` — адрес слота, `ldd` — чтение, `std` — запись) и арифметику `adds`. Это **не** замена
 * прогону в порте: `FIR = 181` проверяется шлюзом `npm run gate:qemu` (там же и полный конвейер).
 *
 * # Почему память, а не «взять регистр у рантайма»
 *
 * Регистры `%b[10..15]` заняты рантаймом массивов (`src/e2k/arrayRuntime.ts`) и брать их нельзя —
 * это не наш выбор, а измеренный контракт (`%b[15]` — указатель кучи). Адрес слота в e2k — **сумма
 * двух регистров**, поля смещения в команде нет, поэтому адрес слота кладётся литералом (`movtd`),
 * а смещением служит `%b[12]` (ноль рантайма, который никто не переписывает).
 */

import { describe, it, expect } from 'vitest';
import { getEncoder, type AsmInstruction, type Operand } from '../e2k/backend';
import { allocateProgram } from '../e2k/regAlloc';
import { lowerCarrier } from '../e2k/e2kRealRun';
import { ARRAY_REGISTERS } from '../e2k/arrayRuntime';
import { emitShell } from '../e2k/emitterShell';
import { annotateAtomRegions } from '../compiler/atomRegions';
import { FIR_REFERENCE_SOURCE } from '../e2k/firReference';
import { defUseOf } from '../e2k/liveness';
import { regModuleOf } from './regOracle';
import { MAX_SPILLS_PER_PROCEDURE, SPILL_LOAD, SPILL_STORE } from './spill';

/** Адрес области вытеснения. В модели он ни на что не влияет: важно, что он ЗАДАН, а не выдуман. */
const SPILL_BASE = 0x103000;

const reg = (index: number): Operand => ({ kind: 'reg', index });
const imm = (value: number): Operand => ({ kind: 'imm', value });
const carrier = (mnemonic: string, operands: Operand[]): AsmInstruction => ({ mnemonic, channel: 0, operands });

/**
 * Программа с заданным числом ОДНОВРЕМЕННО живых значений и ровно восемью свободными регистрами.
 *
 * Два параметра (`v0`, `v1`) — входящие, значит закреплённые: свободных регистров
 * `10 − 2 = 8`. Значения `v2…v_{count+1}` строятся цепочкой (все различны) и все читаются в конце,
 * поэтому в точке последнего определения живы все `count` значений сразу.
 *
 * Результат при `v0 = v1 = 1`: `2 + 3 + … + (count+1) = count·(count+3)/2`.
 */
function liveValuesProgram(count: number): AsmInstruction[] {
  const program: AsmInstruction[] = [carrier('IR.add', [reg(2), reg(0), reg(1)])];
  for (let index = 3; index <= count + 1; index++) {
    program.push(carrier('IR.add', [reg(index), reg(index - 1), reg(0)]));
  }
  let sum = 2;
  let next = count + 2;
  for (let index = 3; index <= count + 1; index++) {
    program.push(carrier('IR.add', [reg(next), reg(sum), reg(index)]));
    sum = next;
    next++;
  }
  program.push(carrier('IR.ret', [imm(1), reg(sum)]));
  return program;
}

const expectedResult = (count: number): number => (count * (count + 3)) / 2;

/** Процедура-обёртка для `allocateProgram`: одна процедура от нуля. */
function proceduresOf(program: readonly AsmInstruction[]): { name: string; codeOffset: number; vregs: number }[] {
  const vregs = new Set<number>();
  for (const instruction of program) {
    const { def, use } = defUseOf(instruction);
    for (const vreg of [...def, ...use]) vregs.add(vreg);
  }
  return [{ name: 'проба', codeOffset: 0, vregs: vregs.size }];
}

/**
 * МАЛЕНЬКАЯ МОДЕЛЬ: только те команды, из которых состоит вытеснение, и арифметика.
 *
 * Незнакомая команда — **исключение**, а не молчание: иначе «исполнение прошло» ничего не значило
 * бы (та же дисциплина, что в `src/e2k/arrayHeap.test.ts`).
 */
function runProgram(commands: readonly AsmInstruction[], resultRegister: number): number {
  const registers = new Map<number, number>([
    [0, 1],
    [1, 1],
    [ARRAY_REGISTERS.zero, 0],
  ]);
  const memory = new Map<number, number>();
  const value = (operand: Operand | undefined): number => {
    if (operand === undefined) throw new Error('операнда нет');
    if (operand.kind === 'imm') return operand.value;
    if (operand.kind === 'imm64') return Number(operand.value);
    if (operand.kind === 'reg') {
      const held = registers.get(operand.index);
      if (held === undefined) {
        throw new Error(`%b[${String(operand.index)}] не определён — модель не описывает программу`);
      }
      return held;
    }
    throw new Error(`операнд вида ${operand.kind} модель не описывает`);
  };
  const indexOf = (operand: Operand | undefined): number => {
    if (operand === undefined || operand.kind !== 'reg') throw new Error('ожидался регистр-приёмник');
    return operand.index;
  };
  for (const instruction of commands) {
    const operands = instruction.operands;
    switch (instruction.mnemonic) {
      case 'adds':
        registers.set(indexOf(operands[2]), value(operands[0]) + value(operands[1]));
        break;
      case 'movtd':
        registers.set(indexOf(operands[1]), value(operands[0]));
        break;
      case 'ldd':
        registers.set(indexOf(operands[2]), memory.get(value(operands[0]) + value(operands[1])) ?? 0);
        break;
      case 'std':
        memory.set(value(operands[1]) + value(operands[2]), value(operands[0]));
        break;
      default:
        throw new Error(`«${instruction.mnemonic}»: модель не описывает эту команду`);
    }
  }
  const held = registers.get(resultRegister);
  if (held === undefined) throw new Error(`регистр результата %b[${String(resultRegister)}] не определён`);
  return held;
}

/** Понизить носители в команды — то же, что делает конвейер перед исполнением. */
function lowerAll(instructions: readonly AsmInstruction[]): AsmInstruction[] {
  const commands: AsmInstruction[] = [];
  for (const instruction of instructions) {
    if (instruction.mnemonic === 'IR.ret') continue;
    const lowered = lowerCarrier(instruction);
    if (!lowered.ok) throw new Error(`«${instruction.mnemonic}»: ${lowered.reason}`);
    commands.push(...lowered.instructions);
  }
  return commands;
}

/** Регистр-результат: его несёт носитель возврата (он один и последний). */
function resultRegisterOf(instructions: readonly AsmInstruction[]): number {
  const returns = instructions.filter((instruction) => instruction.mnemonic === 'IR.ret');
  const returned = returns.at(-1)?.operands[1];
  if (returned === undefined || returned.kind !== 'reg') throw new Error('у возврата нет регистра-значения');
  return returned.index;
}

describe('минимальное вытеснение в память', () => {
  it('1.1 девять живых значений при восьми свободных: раскладка удаётся и результат верный', () => {
    const count = 9;
    const program = liveValuesProgram(count);
    const result = allocateProgram(program, proceduresOf(program), { spill: { base: SPILL_BASE } });
    const report = result.report[0]!;
    expect(report.ok, report.ok ? '' : `отказ: ${report.reason ?? 'причина не названа'}`).toBe(true);
    if (!report.ok) return;
    expect(report.spilled.length, 'вытеснено значений').toBeGreaterThanOrEqual(1);
    expect(report.spilled.length, 'вытеснений на процедуру').toBeLessThanOrEqual(MAX_SPILLS_PER_PROCEDURE);
    // Вытеснение — не счётчик в отчёте, а носители в потоке.
    const mnemonics = result.instructions.map((instruction) => instruction.mnemonic);
    expect(mnemonics.filter((mnemonic) => mnemonic === SPILL_LOAD).length, 'чтений из памяти').toBeGreaterThan(0);
    expect(mnemonics.filter((mnemonic) => mnemonic === SPILL_STORE).length, 'записей в память').toBeGreaterThan(0);
    // И главное: значение, побывавшее в памяти, доезжает до результата.
    const executed = runProgram(lowerAll(result.instructions), resultRegisterOf(result.instructions));
    expect(executed, `результат программы (${String(count)} значений)`).toBe(expectedResult(count));
  });

  it('1.2 вытеснений нужно больше двух — отказ с причиной, а не тихая потеря значения', () => {
    const program = liveValuesProgram(12);
    const result = allocateProgram(program, proceduresOf(program), { spill: { base: SPILL_BASE } });
    const report = result.report[0]!;
    expect(report.ok, 'раскладка прошла там, где нужно больше двух вытеснений').toBe(false);
    expect(report.reason ?? '', 'причина отказа').toMatch(new RegExp(`двух|${String(MAX_SPILLS_PER_PROCEDURE)}`));
  });

  it('1.3 FIR = 181 не ломается: эталонный источник FIR вытеснения не получает', () => {
    const built = regModuleOf(FIR_REFERENCE_SOURCE);
    if (built === null) throw new Error('эталонный источник FIR не компилируется');
    const annotated = annotateAtomRegions(built.module, [
      { atom: 'A5', procedures: built.module.procedures.map((procedure) => procedure.name) },
    ]);
    const emitted = emitShell(annotated, getEncoder('internal-shell'));
    const result = allocateProgram(emitted.instructions, emitted.scheduled.procedures, {
      spill: { base: SPILL_BASE },
    });
    for (const report of result.report) {
      expect(report.spilled, `${report.procedure}: вытеснено`).toEqual([]);
    }
    // Ни одного носителя вытеснения в потоке: поток эталонного источника не изменился.
    const spillCarriers = result.instructions.filter(
      (instruction) => instruction.mnemonic === SPILL_LOAD || instruction.mnemonic === SPILL_STORE,
    );
    expect(spillCarriers, 'носители вытеснения в эталонном источнике').toEqual([]);
  });

  it('1.4 негативный контроль: без вытеснения та же программа раскладку не проходит', () => {
    const program = liveValuesProgram(9);
    const without = allocateProgram(program, proceduresOf(program));
    const report = without.report[0]!;
    expect(report.ok, 'раскладка прошла без вытеснения — тогда проверка 1.1 ничего не доказывает').toBe(false);
    expect(report.reason ?? '', 'причина отказа').toMatch(/отрезков|регистр/);
  });
});
