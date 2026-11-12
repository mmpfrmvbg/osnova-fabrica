/**
 * ПОТОК ЯДРА DSP ДО КОМАНД e2k — ОДНО МЕСТО ДЛЯ ЗАМЕРА И ДЛЯ CI.
 *
 * Раньше этот путь жил только в `src/e2k/e2kWideFir.test.ts` и был экспортирован ИЗ ТЕСТА:
 * другие оракулы импортировали `kernelStreamOf` из `.test.ts`. Для шлюза `gate` это не годится —
 * CI обязан печатать ЧИСЛА (`FIR-ядро=268`, `пять ядер=979`, `пакеты=220`), а не «тест прошёл»,
 * и брать их из реального понижения, а не из литерала в конфиге. Импортировать тест из `tsx`-скрипта
 * нельзя: модуль теста на верхнем уровне зовёт `describe`, которого вне vitest нет.
 *
 * Поэтому путь понижения вынесен сюда без изменения порядка шагов: раскладка → сопоставление пар →
 * понижение носителей. Числа замера не переписаны — они те же, что были в оракуле.
 */
import * as fs from 'fs';
import * as path from 'path';
import { getEncoder, type AsmInstruction } from './backend';
import { emitShell } from './emitterShell';
import { annotateAtomRegions } from '../compiler/atomRegions';
import { regModuleOf } from '../vliw/regOracle';
import { layoutOf, secondPass, CALLEE_REGISTERS } from './twoPassLayout';
import { pairPredicates } from './predicatePairing';
import { callDisplacementsOf, lowerCarrier, type LoweringContext } from './e2kRealRun';
import { allocateProgram } from './regAlloc';
import { SUPPORTED_ARRAY_CALLS } from './arrayRuntime';
import { entryProcedureIndex } from './procedureCall';

const ROOT = path.resolve(__dirname, '..', '..');
const KERNELS_DIR = path.join(ROOT, 'tests', 'dsp', 'kernels');

/** Пять ядер DSP и атомы, к которым они приписаны. */
export const KERNELS: ReadonlyArray<{ name: string; atom: string }> = [
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
  /** Сколько носителей отказало ПО МНЕМОНИКЕ (иначе две тысячи отказов выглядели бы одной записью). */
  readonly refusedCarriers: ReadonlyMap<string, number>;
  /** Всего отказавших носителей. */
  readonly refusedTotal: number;
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
  readonly constants: readonly unknown[];
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
  // ── КОНФИГУРАЦИЯ РАСКЛАДКИ — КОНФИГУРАЦИЯ КОМПИЛЯТОРА (§3.131) ────────────────────────────────
  //
  // Прежде раскладка звалась БЕЗ ОПЦИЙ. С §3.128 этого мало, и это выяснилось замером: понижение
  // `IR.invoke` к массивам требует БАЗЫ БЛОКА, которую выдаёт раскладка, — а без пометки процедур
  // базы не получал НИКТО, и все 22 обращения ядра отказывали (команд 263 → 103: мерилась не та
  // конфигурация, что выдаёт компилятор). Здесь повторено ровно то, что делает конвейер
  // (`src/e2k/guards/loweredUnchecked.ts#loweredProgramUnchecked`): процедуры с обращениями к массивам помечены, точке
  // входа — её пул, вызываемой — `CALLEE_REGISTERS`.
  const entryAt = entryProcedureIndex(emitted.scheduled.procedures);
  const arrayProcedures = emitted.scheduled.procedures
    .map((procedure, at) => {
      const to = emitted.scheduled.procedures[at + 1]?.codeOffset ?? emitted.instructions.length;
      const usesArrays = emitted.instructions.slice(procedure.codeOffset, to).some((carrier) => {
        if (carrier.mnemonic !== 'IR.invoke') return false;
        const payload = carrier.operands[3];
        const name = payload !== undefined && payload.kind === 'imm' ? emitted.image.invokeNames[payload.value] : undefined;
        return name !== undefined && SUPPORTED_ARRAY_CALLS.includes(name);
      });
      return usesArrays ? at : undefined;
    })
    .filter((at): at is number => at !== undefined);
  const allocation = allocateProgram(emitted.instructions, emitted.scheduled.procedures, {
    arrayProcedures,
    freeFor: (at: number) => (at === entryAt ? undefined : CALLEE_REGISTERS),
  });
  const stream = allocation.instructions;
  // Контекст понижения — ПО ПРОЦЕДУРАМ, как в конвейере: базу блока знает только процедура, которой
  // её выдала раскладка, и признак вызываемой тоже её (куча и оконная форма — свойства плоскости).
  const procedureContextAt = new Map<number, { arrayBase?: number; inCallee: boolean }>();
  allocation.procedures.forEach((procedure, at) => {
    const to = allocation.procedures[at + 1]?.codeOffset ?? stream.length;
    for (let index = procedure.codeOffset; index < to; index++) {
      const base = allocation.arrayBases[at];
      procedureContextAt.set(index, {
        ...(base === undefined ? {} : { arrayBase: base }),
        inCallee: at !== entryAt,
      });
    }
  });
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
  /**
   * СКОЛЬКО НОСИТЕЛЕЙ НАЗВАНО ОТКАЗОМ — по мнемонике, а не «есть отказ или нет» (§3.131).
   *
   * `refusals` хранит ПРИЧИНУ по мнемонике, поэтому две тысячи отказов `IR.invoke` выглядели бы там
   * одной записью. Числа упаковки считаются по ПОНИЖЕННОЙ части потока, и без этого счётчика
   * «команд 229» читалось бы как «столько команд в ядре», тогда как 13 обращений к массивам в
   * вызываемых процедурах не понижены вовсе.
   */
  const refusedCarriers = new Map<string, number>();
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
      ...(procedureContextAt.get(index) ?? {}),
      ...(displacementAt.has(index) ? { displacement: displacementAt.get(index)! } : {}),
      ...(callDisplacementAt.has(index) ? { callDisplacement: callDisplacementAt.get(index)! } : {}),
      ...(predicateAt.has(index) ? { predicate: predicateAt.get(index)! } : {}),
      ...(conditionAt.has(index) ? { condition: conditionAt.get(index)! } : {}),
    };
    const lowered = lowerCarrier(carrier, context);
    if (!lowered.ok) {
      refusals.set(carrier.mnemonic, lowered.reason);
      refusedCarriers.set(carrier.mnemonic, (refusedCarriers.get(carrier.mnemonic) ?? 0) + 1);
      continue;
    }
    commandIndices.push(index);
    commands.push(...lowered.instructions);
  }
  return {
    carriers: emitted.instructions.length,
    commands,
    refusals,
    refusedCarriers,
    refusedTotal: [...refusedCarriers.values()].reduce((sum, count) => sum + count, 0),
    carrierStream: stream,
    invokeNames: emitted.image.invokeNames,
    commandIndices,
    constants: emitted.scheduled.constants,
  };
}
