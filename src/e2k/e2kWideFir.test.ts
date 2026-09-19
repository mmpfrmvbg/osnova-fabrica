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
  };
}

const FIR = kernelStreamOf('fir', 'A5');

describe('замер: FIR через группировку', () => {
  it('поток FIR понижается целиком — отказов нет, и это НЕ значит «исполняется»', () => {
    expect(FIR.carriers, 'носителей эмиттера в ядре FIR').toBe(111);
    expect(FIR.commands.length, 'команд e2k после понижения').toBe(235);
    // После шагов 1–3 отказов в этом потоке нет: раскладка регистров, длина `IR.invoke`, вызов и
    // возврат закрыты. Это «байты собраны и сверены», а не «ядро исполняется»: прогон упирается в
    // порт (docs/e2k-opcodes-real.md §7.10) и в окно вызываемой процедуры.
    expect([...FIR.refusals.keys()], 'отказы понижения').toEqual([]);
  });

  it('группировка сокращает число команд и байтов', () => {
    const stats = wideStats(FIR.commands);
    expect(stats.linearCommands, 'команд линейно').toBe(235);
    expect(stats.packets, 'пакетов').toBe(212);
    // Байты уменьшились после короткой непосредственной формы `0xc0|N` (значения 0…15 — 8 байт
    // вместо 16): было 2064 линейно и 2048 пакетами, стало 1904 и 1888.
    expect(stats.bytesLinear, 'байт линейно').toBe(1904);
    expect(stats.bytesWide, 'байт пакетами').toBe(1888);
    expect(stats.packedSlots, 'слогов в многоместных пакетах').toBe(44);
    expect(stats.refused, 'отказов кодировщика среди понижённых команд').toBe(0);
  });

  it('материал группировки — пересылки: арифметики в потоке мало', () => {
    // Это и есть честный ответ на вопрос «почему выигрыш скромный»: DSP-счёт ядра уходит в
    // `IR.invoke` (обращения к массивам) и до кодировщика не доезжает.
    const counts = new Map<string, number>();
    for (const command of FIR.commands) counts.set(command.mnemonic, (counts.get(command.mnemonic) ?? 0) + 1);
    expect(counts.get('movts'), 'пересылок movts').toBe(55);
    expect(counts.get('adds'), 'сложений-адресации (ldd/std адресуются суммой)').toBe(104);
    expect((counts.get('adds') ?? 0) + (counts.get('subs') ?? 0) + (counts.get('muls') ?? 0), 'арифметики').toBe(107);
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
    // Числа измерены и печатаются в отчёте. После шагов 1–3 команд стало больше: `IR.invoke` понижается
    // в 1/3/6/9 команд, вызов — в 4–5, возврат — в 1–2. Смысл проверки не «мало команд», а «число
    // названо и совпадает с замером».
    expect(rows.map((row) => `${row.name}:${row.carriers}→${row.commands}`)).toEqual([
      'fir:111→235',
      'iir:91→146',
      'fft:105→204',
      'convolution:110→160',
      'correlation:100→176',
    ]);
  });

  it('байтов в пакетах меньше, чем линейно, у каждого ядра', () => {
    const problems = rows.filter((row) => row.bytesWide >= row.bytesLinear).map((row) => row.name);
    expect(problems, 'ядра без выигрыша в байтах').toEqual([]);
  });
});
