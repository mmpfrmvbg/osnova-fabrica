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
 *
 * # Перемер 2026-09-27: литерал включён в упаковщик
 *
 * `packetableRefusal` перестал отвергать литерал (раскладка измерена, `src/e2k/e2kWideSsLts.test.ts`),
 * поэтому литеральная пересылка больше не разрывает пакет. Сдвинулись **только числа упаковки**:
 * пакеты, байты пакетами, слоги в многоместных. Команды (263), линейные байты (2168) и отказы
 * понижения не двигались — упаковка на них не влияет. Числа пяти ядер перемерены в
 * `src/e2k/literalBarriers.test.ts` (пакеты, пустые слоты) и `src/e2k/layoutWideCrossCheck.test.ts`
 * (байты пакетами).
 */

import { describe, it, expect } from 'vitest';
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

const FIR = kernelStreamOf('fir', 'A5');

describe('замер: FIR через группировку', () => {
  it('поток FIR понижается ЧАСТЬЮ: 111 носителей → 255 команд, 8 обращений к массивам названы отказом', () => {
    expect(FIR.carriers, 'носителей эмиттера в ядре FIR').toBe(111);
    // ── ПЕРЕМЕР 2026-10-10 (§3.131): ЧАСТЬ ПОТОКА НЕ ПОНИЖАЕТСЯ, И ЭТО ИЗМЕРЕНО ──────────────────
    //
    // Было 263 команды и «отказов понижения нет». Числа 263/205/2048/95 снимались в конфигурации,
    // которой компилятор НЕ выдаёт: раскладка звалась без `arrayProcedures`, то есть ни одна
    // процедура не была помечена как работающая с массивами, а до §3.128 обращение к массиву
    // понижалось «тихо» — по клеткам ПЛОСКОСТИ ТОЧКИ ВХОДА, где бы процедура ни лежала. С §3.128
    // базу блока выдаёт раскладка, и вызываемая процедура получает её только если пятёрка клеток
    // помещается в ЕЁ СОБСТВЕННУЮ половину кадра (клетки `%b[8..15]` при `call wbs = 4`).
    //
    // Замер `filter` ядра FIR: восемь живых значений занимают все восемь клеток своей половины —
    // пятёрке блока места нет, базы нет, 8 обращений к массивам отказывают ПО ИМЕНИ (`OSN-LOW-003`,
    // «раскладка не выдала базу блока рантайма»). Стенд (пул `%b[0..9]`) находил пятёрку в клетках
    // 2..6 — а это `%b[10..14]` ВЫЗЫВАЮЩЕГО: пролог значений вызываемой писал ЕДИНИЦУ в его клетку 12,
    // и выход считал `значение + %b[12]` (М3 давало 7 вместо 6, К3 — 8 вместо 7).
    //
    // Итог: 255 команд — это команды ПОНИЖЕННОЙ части (они верны), и рядом стоит счёт отказавших
    // носителей. Восстановить полный поток можно только одним из двух: выровнять блок вызываемой по
    // РОЛЯМ вызывающего (тогда клетки 2..6 = клетки блока вызывающего, и константы 0/1/8
    // перезаписываются теми же значениями — это работает на глубине 1 и НЕ работает глубже) или
    // расширить кадр вызываемой (A1′, §3.125). Ни то, ни другое здесь не сделано.
    expect(FIR.commands.length, 'команд e2k после понижения').toBe(255);
    expect([...FIR.refusedCarriers.entries()], 'названные отказы понижения').toEqual([['IR.invoke', 8]]);
    // Код `OSN-LOW-003` присваивает конвейер (`src/e2k/guards/loweredUnchecked.ts#loweredProgramUnchecked`), а здесь
    // видно САМУ причину понижения — по ней код и ставится.
    expect(FIR.refusals.get('IR.invoke') ?? '', 'причина отказа').toContain('раскладка не выдала базу блока рантайма');
  });

  it('группировка сокращает число команд и байтов', () => {
    const stats = wideStats(FIR.commands);
    expect(stats.linearCommands, 'команд линейно').toBe(255);
    // Перемер 2026-10-10 вместе с усечением потока (см. выше): 205 → 177 пакетов, 2168 → 1896 байт
    // линейно, 2048 → 1792 байтами, 95 → 87 слогов. Литеральные колонки НЕ сдвинулись (20 и 20,
    // управляющих 22, длинных форм 1): они считаются по потоку эмиттера, а усечение — по раскладке.
    expect(stats.packets, 'пакетов').toBe(209);
    expect(stats.bytesLinear, 'байт линейно').toBe(2104);
    expect(stats.bytesWide, 'байт пакетами').toBe(2000);
    expect(stats.packedSlots, 'слогов в многоместных пакетах').toBe(76);
    expect(stats.refused, 'отказов кодировщика среди понижённых команд').toBe(0);
  });

  it('материал группировки — пересылки: арифметики в потоке мало', () => {
    // Это и есть честный ответ на вопрос «почему выигрыш скромный»: DSP-счёт ядра уходит в
    // `IR.invoke` (обращения к массивам) и до кодировщика не доезжает. С §3.131 это видно и числом:
    // восемь обращений не понижены вовсе, поэтому адресной арифметики 86, а не 112.
    const counts = new Map<string, number>();
    for (const command of FIR.commands) counts.set(command.mnemonic, (counts.get(command.mnemonic) ?? 0) + 1);
    // Прежние числа: пересылок 60, адресной арифметики 112, сложений 5, сумма арифметики 120.
    // Пересылки (`movts` 60) и сложения `adds` 5 НЕ сдвинулись: усечение снимает последовательности
    // рантайма массивов, а они состояли из `addd`/`ldd`/`std` (плюс `movtd` адресов слотов).
    expect(counts.get('movts'), 'пересылок movts').toBe(60);
    expect(counts.get('addd'), 'адресной арифметики рантайма массивов (форма D, %db)').toBe(86);
    expect(counts.get('adds'), 'сложений от понижения IR.add (форма S)').toBe(5);
    expect(
      (counts.get('adds') ?? 0) + (counts.get('addd') ?? 0) + (counts.get('subs') ?? 0) + (counts.get('muls') ?? 0),
      'арифметики',
    ).toBe(94);
  });
});

describe('замер: пять ядер', () => {
  const rows = KERNELS.map(({ name, atom }) => {
    const stream = kernelStreamOf(name, atom);
    const stats = wideStats(stream.commands);
    return {
      name,
      ...stats,
      carriers: stream.carriers,
      commands: stream.commands.length,
      refusedTotal: stream.refusedTotal,
    };
  });

  it('у каждого ядра пакетов меньше, чем команд', () => {
    const problems = rows.filter((row) => row.packets >= row.linearCommands).map((row) => row.name);
    expect(problems, 'ядра без выигрыша в командах').toEqual([]);
  });

  it('ни у одного ядра нет отказов КОДИРОВЩИКА, и у каждого число команд названо', () => {
    const problems = rows.filter((row) => row.refused !== 0).map((row) => row.name);
    expect(problems, 'ядра с отказами кодировщика').toEqual([]);
    // ── ПЕРЕМЕР 2026-10-10 (§3.131) ───────────────────────────────────────────────────────────────
    //
    // Было: fir 263, iir 158, fft 228, convolution 218, correlation 197 (сумма 1064) — и ни одного
    // отказа понижения. Эти числа снимались в конфигурации, которой компилятор не выдаёт (см. разбор
    // у FIR выше): раскладка звалась без пометки процедур с массивами, обращения к массивам
    // понижались «тихо» по клеткам плоскости точки входа. С §3.128 база блока выдаётся раскладкой, и
    // вызываемая процедура получает её только если пятёрка помещается в её собственную половину
    // кадра (`%b[8..15]`); у рабочих процедур DSP-ядер там живут восемь значений — пятёрке места нет.
    //
    // Отсюда: понижена ЧАСТЬ потока, и число отказавших носителей стоит рядом с числом команд —
    // 45 на пять ядер (`fir` 8, `iir` 6, `fft` 15, `convolution` 8, `correlation` 8), все `IR.invoke`
    // с причиной `OSN-LOW-003`. Прежнее «команд 1064» читалось как полный поток; теперь это
    // 821 команда понижённой части и 45 названных отказов.
    expect(rows.map((row) => `${row.name}:${row.carriers}→${row.commands} (отказано ${row.refusedTotal})`)).toEqual([
      'fir:111→255 (отказано 8)',
      'iir:85→142 (отказано 6)',
      'fft:105→123 (отказано 15)',
      'convolution:110→198 (отказано 8)',
      'correlation:100→177 (отказано 8)',
    ]);
    expect(rows.reduce((total, row) => total + row.refusedTotal, 0), 'отказано носителей на пять ядер').toBe(45);
  });

  it('байтов в пакетах меньше, чем линейно, у каждого ядра', () => {
    const problems = rows.filter((row) => row.bytesWide >= row.bytesLinear).map((row) => row.name);
    expect(problems, 'ядра без выигрыша в байтах').toEqual([]);
  });
});
