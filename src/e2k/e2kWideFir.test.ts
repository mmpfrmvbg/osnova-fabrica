/**
 * ЗАМЕР: ЧТО ДАЁТ ГРУППИРОВКА НА РЕАЛЬНОМ ПОТОКЕ DSP-ЯДРА.
 *
 * # Зачем этот файл
 *
 * Главная гипотеза проекта — «VLIW-планировщик, соединённый с реальной кодировкой e2k, даёт
 * измеримый выигрыш на DSP-задаче». Здесь измеряется та часть, которая достижима сегодня:
 * **понижённый поток** ядра (то, что уже умеет кодировщик) упаковывается в широкие команды.
 *
 * Полного прогона FIR в QEMU здесь **нет**, и причина названа числом: 24 носителя из 111 не
 * понижаются (`IR.invoke`, `IR.ret`, `IR.call`) — ядру нужны обращения к памяти, вызовы и цикл,
 * а кодировщик умеет только слог ALS, литералы и передачу управления. Прогон «FIR = 181» требует
 * памяти и вызовов; оракул это фиксирует, чтобы долг не потерялся.
 *
 * # Что проверяется
 *
 * - понижённый поток FIR упаковывается: команд меньше, чем инструкций, байтов меньше;
 * - отказы понижения названы поимённо (это и есть препятствие к полному прогону);
 * - у всех пяти ядер пакетов меньше, чем команд (группировка не вырождена).
 *
 * Числа — **измерения этой сессии** (2026-09-19). Оракул их фиксирует: если они изменятся,
 * это не «мелкое расхождение», а повод объяснить, почему.
 */

import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { getEncoder, type AsmInstruction } from './backend';
import { emitShell } from './emitterShell';
import { annotateAtomRegions } from '../compiler/atomRegions';
import { regModuleOf } from '../vliw/regOracle';
import { layoutOf, secondPass } from './twoPassLayout';
import { pairPredicates } from './predicatePairing';
import { callDisplacementsOf, lowerCarrier, type LoweringContext } from './e2kRealRun';
import { allocateProgram } from './regAlloc';
import { wideStats } from './widePacker';

const ROOT = path.resolve(__dirname, '..', '..');
const KERNELS_DIR = path.join(ROOT, 'tests', 'dsp', 'kernels');

const KERNELS: ReadonlyArray<{ name: string; atom: string }> = [
  { name: 'fir', atom: 'A5' },
  { name: 'iir', atom: 'A5' },
  { name: 'fft', atom: 'A5' },
  { name: 'convolution', atom: 'A6' },
  { name: 'correlation', atom: 'A6' },
];

/** Понижённый поток ядра: команды e2k в порядке программы и отказы понижения. */
export interface KernelStream {
  readonly carriers: number;
  readonly commands: readonly AsmInstruction[];
  readonly refusals: ReadonlyMap<string, string>;
  /**
   * Поток НОСИТЕЛЕЙ IR, из которого построены команды, — то, что размещает раскладка.
   *
   * Нужен сверке раскладки с упаковщиком (`src/e2k/layoutWideCrossCheck.test.ts`): у отвергнутых
   * носителей адрес раскладкой уже присвоен, поэтому «раскладка против линейных байт» без этого
   * поля не сверить.
   */
  readonly carrierStream: readonly AsmInstruction[];
  /** Имена хост-вызовов образа: без них `IR.invoke` не размещается. */
  readonly invokeNames: readonly string[];
  /** Индексы носителей, дошедших до команд (остальные отвергнуты раскладкой или понижением). */
  readonly commandIndices: readonly number[];
  /**
   * Пул констант образа.
   *
   * Нужен сверке раскладки (`src/e2k/layoutWideCrossCheck.test.ts`): без пула `IR.const` берётся
   * ЛИТЕРАЛЬНОЙ формой (LTS, 16 байт) и раскладка показывает больше байт, чем есть на самом деле, —
   * тогда «раскладка − линейные байты» перестаёт объясняться отвергнутыми носителями, хотя причина
   * расхождения совсем другая. Замер: у FIR без пула 1992 байта против 1832 с пулом (линейных 1784).
   */
  readonly constants: readonly { readonly kind: string; readonly value: number }[];
}

/**
 * Повторить путь `runKernelThroughRealEncoding`, но остановиться на командах e2k:
 * раскладка → сопоставление пар → понижение каждого носителя.
 */
export function kernelStreamOf(name: string, atom: string): KernelStream {
  const source = fs.readFileSync(path.join(KERNELS_DIR, `${name}.osnova`), 'utf-8');
  const built = regModuleOf(source);
  if (built === null) throw new Error(`ядро не компилируется: ${name}`);
  const annotated = annotateAtomRegions(built.module, [
    { atom, procedures: built.module.procedures.map((procedure) => procedure.name) },
  ]);
  const emitted = emitShell(annotated, getEncoder('internal-shell'));
  // Поток берётся ТОТ ЖЕ, что идёт в понижение в конвейере: сначала раскладка регистров (устранение
  // копий + отрезки), затем раскладка адресов с именами хост-вызовов и смещениями вызовов. Иначе
  // измерялся бы не тот поток, который кодируется.
  const allocation = allocateProgram(emitted.instructions, emitted.scheduled.procedures);
  const stream = allocation.instructions;
  const layout = layoutOf(stream, { invokeNames: emitted.image.invokeNames });
  const resolved = secondPass(stream, layout.addresses);
  const pairing = pairPredicates(stream);
  const displacementAt = new Map(resolved.displacements.map((item) => [item.index, item.disp]));
  const callDisplacementAt = callDisplacementsOf(stream, allocation.procedures, layout.addresses);
  const predicateAt = new Map(
    pairing.pairs.map((pair) => [pair.comparisonIndex, { mnemonic: pair.cmpMnemonic, index: pair.predicate }]),
  );
  const conditionAt = new Map(pairing.pairs.map((pair) => [pair.jumpIndex, pair.condition]));
  const refusalAt = new Map<number, string>();
  for (const unplaced of layout.unplaced) refusalAt.set(unplaced.index, unplaced.reason);
  for (const refusal of resolved.refusals) refusalAt.set(refusal.index, refusal.reason);
  for (const refusal of pairing.refusals) refusalAt.set(refusal.index, refusal.reason);

  const commands: AsmInstruction[] = [];
  const refusals = new Map<string, string>();
  const commandIndices: number[] = [];
  for (let index = 0; index < stream.length; index++) {
    const carrier = resolved.instructions[index]!;
    const blocked = refusalAt.get(index);
    if (blocked !== undefined) {
      refusals.set(carrier.mnemonic, blocked);
      continue;
    }
    const context: LoweringContext = {
      constants: emitted.scheduled.constants,
      invokeNames: emitted.image.invokeNames,
      ...(displacementAt.has(index) ? { displacement: displacementAt.get(index)! } : {}),
      ...(callDisplacementAt.has(index) ? { callDisplacement: callDisplacementAt.get(index)! } : {}),
      ...(predicateAt.has(index) ? { predicate: predicateAt.get(index)! } : {}),
      ...(conditionAt.has(index) ? { condition: conditionAt.get(index)! } : {}),
    };
    const lowered = lowerCarrier(carrier, context);
    if (!lowered.ok) {
      refusals.set(carrier.mnemonic, lowered.reason);
      continue;
    }
    commandIndices.push(index);
    commands.push(...lowered.instructions);
  }
  return {
    carriers: emitted.instructions.length,
    commands,
    refusals,
    carrierStream: stream,
    invokeNames: emitted.image.invokeNames,
    commandIndices,
    constants: emitted.scheduled.constants,
  };
}

const FIR = kernelStreamOf('fir', 'A5');

describe('замер: FIR через группировку', () => {
  it('поток FIR понижается ЦЕЛИКОМ: 111 носителей → 259 команд, отказов понижения нет', () => {
    expect(FIR.carriers, 'носителей эмиттера в ядре FIR').toBe(111);
    // Перемер 2026-09-24 (`.tmp/measure-wide-pins.ts`, `.tmp/measure-realrun.ts`): ядро понижается
    // ЦЕЛИКОМ. Причина сдвига — минимальное вытеснение в память (`src/vliw/spill.ts`): рабочая
    // процедура `фильтр` наконец раскладывается (одно значение уезжает в слот), поэтому её 22
    // носителя `IR.invoke` и 1 `IR.call` перестали отказывать. Было: 221 команда и отказы
    // `['IR.call', 'IR.invoke']` — то есть до вытеснения «байты собраны» не означало «понижено».
    expect(FIR.commands.length, 'команд e2k после понижения').toBe(259);
    expect([...FIR.refusals.keys()].sort(), 'отказы понижения').toEqual([]);
  });

  it('группировка сокращает число команд и байтов', () => {
    const stats = wideStats(FIR.commands);
    expect(stats.linearCommands, 'команд линейно').toBe(259);
    // Перемер 2026-09-24 (`.tmp/measure-wide-pins.ts`) после минимального вытеснения: команд 259
    // (было 221), байт линейно 2120 (было 1784), пакетами 2040 (было 1704), пакетов 220,
    // слогов в многоместных 66. До этого — перёмер после перехода на CFG-отрезки: 184 пакета и
    // 63 слога при 221 команде.
    expect(stats.packets, 'пакетов').toBe(220);
    expect(stats.bytesLinear, 'байт линейно').toBe(2120);
    expect(stats.bytesWide, 'байт пакетами').toBe(2040);
    expect(stats.packedSlots, 'слогов в многоместных пакетах').toBe(66);
    expect(stats.refused, 'отказов кодировщика среди понижённых команд').toBe(0);
  });

  it('материал группировки — пересылки: арифметики в потоке мало', () => {
    // Это и есть честный ответ на вопрос «почему выигрыш скромный»: DSP-счёт ядра уходит в
    // `IR.invoke` (обращения к массивам) и до кодировщика не доезжает.
    const counts = new Map<string, number>();
    for (const command of FIR.commands) counts.set(command.mnemonic, (counts.get(command.mnemonic) ?? 0) + 1);
    // Перемер 2026-09-24 вместе с полным понижением ядра: пересылок 60 (было 57), сложений-адресации
    // 117 (было 98), арифметики 120 (было 101) — вытеснение добавляет свои `movtd`/`ldd`/`std`.
    expect(counts.get('movts'), 'пересылок movts').toBe(60);
    expect(counts.get('adds'), 'сложений-адресации (ldd/std адресуются суммой)').toBe(117);
    expect((counts.get('adds') ?? 0) + (counts.get('subs') ?? 0) + (counts.get('muls') ?? 0), 'арифметики').toBe(120);
  });
});

describe('замер: пять ядер', () => {
  const rows = KERNELS.map(({ name, atom }) => {
    const stream = kernelStreamOf(name, atom);
    const stats = wideStats(stream.commands);
    return { name, ...stats, carriers: stream.carriers, commands: stream.commands.length };
  });

  it('у каждого ядра пакетов меньше, чем команд', () => {
    const problems = rows.filter((row) => row.packets >= row.linearCommands).map((row) => row.name);
    expect(problems, 'ядра без выигрыша в командах').toEqual([]);
  });

  it('ни у одного ядра нет отказов КОДИРОВЩИКА, и у каждого число команд названо', () => {
    const problems = rows.filter((row) => row.refused !== 0).map((row) => row.name);
    expect(problems, 'ядра с отказами кодировщика').toEqual([]);
    // Перемер 2026-09-24 после подъёма предела вытеснения до 4 (`.tmp/measure-wide-pins.ts`): ядро
    // `fir` понижается целиком (111 → 259), `correlation` — 199, `convolution` — 232 (свёртка тоже
    // раскладывается: четыре значения в слот). Числа до этого: 'correlation:100→196',
    // 'convolution:110→174'.
    expect(rows.map((row) => `${row.name}:${row.carriers}→${row.commands}`)).toEqual([
      'fir:111→259',
      'iir:91→161',
      'fft:105→228',
      'convolution:110→232',
      'correlation:100→199',
    ]);
  });

  it('байтов в пакетах меньше, чем линейно, у каждого ядра', () => {
    const problems = rows.filter((row) => row.bytesWide >= row.bytesLinear).map((row) => row.name);
    expect(problems, 'ядра без выигрыша в байтах').toEqual([]);
  });
});
