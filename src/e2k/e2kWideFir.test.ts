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
import { lowerCarrier, type LoweringContext } from './e2kRealRun';
import { packWide, wideStats } from './widePacker';

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
  const layout = layoutOf(emitted.instructions);
  const resolved = secondPass(emitted.instructions, layout.addresses);
  const pairing = pairPredicates(emitted.instructions);
  const displacementAt = new Map(resolved.displacements.map((item) => [item.index, item.disp]));
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
  for (let index = 0; index < emitted.instructions.length; index++) {
    const carrier = resolved.instructions[index]!;
    const blocked = refusalAt.get(index);
    if (blocked !== undefined) {
      refusals.set(carrier.mnemonic, blocked);
      continue;
    }
    const context: LoweringContext = {
      constants: emitted.scheduled.constants,
      ...(displacementAt.has(index) ? { displacement: displacementAt.get(index)! } : {}),
      ...(predicateAt.has(index) ? { predicate: predicateAt.get(index)! } : {}),
      ...(conditionAt.has(index) ? { condition: conditionAt.get(index)! } : {}),
    };
    const lowered = lowerCarrier(carrier, context);
    if (!lowered.ok) {
      refusals.set(carrier.mnemonic, lowered.reason);
      continue;
    }
    commands.push(...lowered.instructions);
  }
  return { carriers: emitted.instructions.length, commands, refusals };
}

const FIR = kernelStreamOf('fir', 'A5');

describe('замер: FIR через группировку', () => {
  it('поток FIR понижается не весь — препятствие названо поимённо', () => {
    expect(FIR.carriers, 'носителей IR в ядре FIR').toBe(111);
    expect(FIR.commands.length, 'команд e2k после понижения').toBe(87);
    // 24 носителя из 111 не понижаются — именно они и мешают прогону «FIR = 181» в QEMU.
    const refused = [...FIR.refusals.keys()].sort();
    expect(refused, 'отказы понижения').toEqual(['IR.call', 'IR.invoke', 'IR.ret']);
    expect(
      FIR.refusals.get('IR.invoke')?.length ?? 0,
      'причина отказа IR.invoke не названа',
    ).toBeGreaterThan(30);
  });

  it('группировка сокращает число команд и байтов', () => {
    const stats = wideStats(FIR.commands);
    expect(stats.linearCommands, 'команд линейно').toBe(87);
    expect(stats.packets, 'пакетов').toBe(67);
    expect(stats.bytesLinear, 'байт линейно').toBe(864);
    expect(stats.bytesWide, 'байт пакетами').toBe(824);
    expect(stats.packedSlots, 'слогов в многоместных пакетах').toBe(33);
    expect(stats.refused, 'отказов кодировщика среди понижённых команд').toBe(0);
  });

  it('материал группировки — пересылки: арифметики в потоке мало', () => {
    // Это и есть честный ответ на вопрос «почему выигрыш скромный»: DSP-счёт ядра уходит в
    // `IR.invoke` (обращения к массивам) и до кодировщика не доезжает.
    const counts = new Map<string, number>();
    for (const command of FIR.commands) counts.set(command.mnemonic, (counts.get(command.mnemonic) ?? 0) + 1);
    expect(counts.get('movts'), 'пересылок movts').toBe(64);
    expect((counts.get('adds') ?? 0) + (counts.get('subs') ?? 0) + (counts.get('muls') ?? 0), 'арифметики').toBe(8);
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

  it('ни у одного ядра поток не понижается целиком — и это записано', () => {
    const problems = rows.filter((row) => row.refused !== 0).map((row) => row.name);
    expect(problems, 'ядра с отказами кодировщика').toEqual([]);
    // Отказы понижения есть у всех: числа измерены и печатаются в отчёте.
    expect(rows.map((row) => `${row.name}:${row.carriers}→${row.commands}`)).toEqual([
      'fir:111→87',
      'iir:91→70',
      'fft:105→79',
      'convolution:110→94',
      'correlation:100→82',
    ]);
  });

  it('байтов в пакетах меньше, чем линейно, у каждого ядра', () => {
    const problems = rows.filter((row) => row.bytesWide >= row.bytesLinear).map((row) => row.name);
    expect(problems, 'ядра без выигрыша в байтах').toEqual([]);
  });
});
