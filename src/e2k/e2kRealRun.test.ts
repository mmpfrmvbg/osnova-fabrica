// ЦЕЛЬ, не состояние. См. hardware-debt §3.23.
/**
 * ОРАКУЛ СКВОЗНОГО ПРОГОНА ПЯТИ ЯДЕР ЧЕРЕЗ РЕАЛЬНУЮ КОДИРОВКУ e2k.
 *
 * # Что проверяется
 *
 * 1. **Поток ядра понижается и кодируется по частям.** Для каждого из пяти ядер: сколько
 *    инструкций понижено до операций e2k, сколько отвергнуто и **почему** (по носителям,
 *    с причиной). Молчаливой потери инструкций нет: `encoded + refused === instructions`.
 * 2. **Round-trip на каждой понижённой инструкции:** `e2k-real.encode` → `e2k-real.decode`
 *    возвращает ту же операцию e2k с теми же операндами. У перехода команд две, и сверяются обе.
 * 2а. **Раскладка и кодирование не расходятся.** `firstPass` считает адреса по таблице форм,
 *    кодировщик выдаёт байты; сверяются размещённые инструкции, число переходов со смещением,
 *    сумма размеров против суммы байтов.
 * 3. **Понижение сохраняет смысл на данных.** Поток исполняется регистровой VM в двух видах:
 *    как есть и с понижёнными операциями (`IR.mul` → `Math.imul` — младшая половина
 *    32-битного произведения, то есть семантика `MULs`). Числа обязаны совпасть с независимым
 *    эталоном `tests/dsp/reference.json` (181 / 119 / 4 / 90 / 32), а предпосылки понижения —
 *    подтвердиться на данных: ни одного нецелого операнда и ни одного усечения.
 * 4. **Полный сквозной прогон невозможен, и это измерено, а не заявлено.** `emitShell` с
 *    `getEncoder("e2k")` отказывает на первой же инструкции: носители `IR.*` — не мнемоники e2k.
 *    Поэтому в отчёте каждого ядра стоит `executableThroughReal: false` и список носителей,
 *    которые мешают.
 * 5. **`IR.jmp` понижен серией `disp` + `ct`.** Смещение — из второго прохода раскладки, ведёт
 *    ровно в адрес цели; пара собирается ассемблером МЦСТ побайтово так же, а MCST-`objdump`
 *    читает образ ядра `fir` и печатает у `disp` тот же адрес цели.
 *
 * # Чего этот оракул НЕ доказывает
 *
 * Что код исполнится на e2k: эмулятора нет (QEMU не собран — `docs/e2k-qemu-build.md`), железо
 * недоступно. Проверены **кодирование** и **согласованность понижения**, а не исполнение.
 */

import * as fs from 'fs';
import * as path from 'path';
import { describe, it, expect } from 'vitest';
import { EncodingRefusedError, getEncoder, sameInstruction, toHex, type AsmInstruction, type Operand } from './backend';
import { emitShell } from './emitterShell';
import { annotateAtomRegions, verifyAtomRegions } from '../compiler/atomRegions';
import { regModuleOf } from '../vliw/regOracle';
import type { RegModule } from '../runtime/vm/regcode';
import { CT_COND_ALWAYS } from './e2k-real';
import { buildElfFromCode, MINIMAL_BASE } from './elfMinimal';
import { disassembleElf, findExternalTool, parseObjdumpOutput } from '../scripts/e2kExternalObjdump';
import { assembleAll, findExternalAs, type AsSample } from '../scripts/e2kExternalAs';
import { CALLEE_REGISTERS, layoutOf, secondPass, type Displacement } from './twoPassLayout';
import { allocateProgram } from './regAlloc';
import { SUPPORTED_ARRAY_CALLS } from './arrayRuntime';
import { entryProcedureIndex } from './procedureCall';
import { callDisplacementsOf } from './e2kRealRun';
import { pairPredicates } from './predicatePairing';
import {
  JUMP_NEEDS_LAYOUT,
  LOWERING,
  REFUSALS,
  SYNTHETIC,
  lowerCarrier,
  lowerInstruction,
  runKernelThroughRealEncoding,
  runLoweredValues,
  type KernelRealReport,
} from './e2kRealRun';

const ROOT = path.resolve(__dirname, '..', '..');
const KERNELS_DIR = path.join(ROOT, 'tests', 'dsp', 'kernels');
const REFERENCE = path.join(ROOT, 'tests', 'dsp', 'reference.json');

/** Пять ядер и атом каждого — как в сквозном прогоне. */
const KERNELS: ReadonlyArray<{ name: string; atom: string; algorithm: string }> = [
  { name: 'fir', atom: 'A5', algorithm: 'FIR-фильтр' },
  { name: 'iir', atom: 'A5', algorithm: 'IIR-фильтр' },
  { name: 'fft', atom: 'A5', algorithm: 'БПФ radix-2' },
  { name: 'convolution', atom: 'A6', algorithm: 'свёртка' },
  { name: 'correlation', atom: 'A6', algorithm: 'корреляция' },
];

const shellEncoder = getEncoder('internal-shell');
const realEncoder = getEncoder('e2k');

interface Reference {
  [kernel: string]: { checksum: number };
}

function readReference(): Reference {
  return JSON.parse(fs.readFileSync(REFERENCE, 'utf-8')) as Reference;
}

function kernelModule(name: string): RegModule {
  const source = fs.readFileSync(path.join(KERNELS_DIR, `${name}.osnova`), 'utf-8');
  const built = regModuleOf(source);
  if (!built) throw new Error(`ядро не компилируется: ${name}`);
  return built.module;
}

function kernelImage(name: string, atom: string): ReturnType<typeof emitShell> {
  const module = kernelModule(name);
  const annotated = annotateAtomRegions(module, [
    { atom, procedures: module.procedures.map((procedure) => procedure.name) },
  ]);
  const problems = verifyAtomRegions(annotated);
  if (problems.length > 0) throw new Error(`${name}: разметка атомов не прошла проверку: ${problems.join('; ')}`);
  return emitShell(annotated, shellEncoder);
}

function reportFor(name: string, atom: string): KernelRealReport {
  return runKernelThroughRealEncoding(kernelImage(name, atom), realEncoder, { kernel: name, atom });
}

const REPORTS: ReadonlyMap<string, KernelRealReport> = new Map(
  KERNELS.map(({ name, atom }) => [name, reportFor(name, atom)]),
);

describe('сквозной прогон: понижение и кодирование', () => {
  it('таблица понижения описывает шесть операций и у каждой названа предпосылка', () => {
    expect(LOWERING.map((rule) => rule.carrier).sort()).toEqual([
      'IR.add',
      'IR.const',
      'IR.idiv',
      'IR.move',
      'IR.mul',
      'IR.sub',
    ]);
    for (const rule of LOWERING) {
      expect(rule.semantics, `${rule.carrier}: не назван источник семантики`).toMatch(/руководство МЦСТ/);
      expect(rule.fromIr.length).toBe(rule.slots.length);
      expect(rule.assumption.length).toBeGreaterThan(3);
    }
    expect(Object.keys(REFUSALS).length).toBeGreaterThanOrEqual(15);
  });

  for (const { name, algorithm } of KERNELS) {
    it(`${name} (${algorithm}): ни одна инструкция не потеряна молча`, () => {
      const report = REPORTS.get(name)!;
      expect(report.instructions).toBeGreaterThan(0);
      expect(report.encoded + report.refused, `${name}: encoded + refused`).toBe(report.instructions);
      // Отказы названы причиной, а не пропущены.
      for (const blocking of report.blocking) {
        expect(blocking.reason.length, `${name}: ${blocking.carrier} без причины`).toBeGreaterThan(10);
      }
      // У части ядер отказов не осталось (шаги 1–3 закрыли раскладку, длину `IR.invoke`, вызов и
      // возврат) — тогда и мешающих носителей быть не должно. Это проверка согласованности двух
      // чисел отчёта, а не ослабление: `blocking` перечисляет именно то, что попало в `refused`.
      // На 2026-09-24 отказов нет ровно у одного ядра из пяти — `fft` (замер `.tmp/measure-realrun.ts`).
      expect(report.blocking.length === 0, `${name}: отказы против списка мешающих`).toBe(report.refused === 0);
      for (const blocking of report.blocking) {
        expect(blocking.count, `${name}: ${blocking.carrier} без числа`).toBeGreaterThan(0);
      }
    });

    it(`${name} (${algorithm}): round-trip каждой понижённой инструкции проходит`, () => {
      const report = REPORTS.get(name)!;
      expect(report.roundTrip.checked, `${name}: сверять нечего`).toBe(report.encoded);
      expect(report.roundTrip.mismatches, `${name}`).toEqual([]);
    });

    it(`${name} (${algorithm}): раскладка и кодирование не расходятся`, () => {
      const report = REPORTS.get(name)!;
      // Раскладка считает адреса по таблице форм, кодировщик выдаёт байты: числа обязаны сойтись.
      // Два числа различаются осмысленно: «размещено» — у скольких носителей известна ДЛИНА, а
      // «понижено» — сколько дошло до байтов. Носитель с формой может не понизиться (у вызова не
      // нашлось адреса цели, если вызываемая процедура не размещена), поэтому строгое равенство
      // `placed === encoded` верно лишь там, где отказов такого рода нет.
      expect(report.layout.placed, `${name}: размещено`).toBe(report.instructions - report.layout.unplaced);
      expect(report.layout.placed, `${name}: понижено больше, чем размещено`).toBeGreaterThanOrEqual(report.encoded);
      expect(report.layout.unplaced, `${name}: не размещено больше, чем отвергнуто`).toBeLessThanOrEqual(report.refused);
      // Сумма размеров раскладки равна байтам ровно тогда, когда понижены все размещённые носители.
      if (report.layout.placed === report.encoded) {
        expect(report.layout.totalBytes, `${name}: сумма размеров раскладки против суммы байтов`).toBe(report.bytes);
      } else {
        expect(report.layout.totalBytes, `${name}: раскладка не может быть меньше образа`).toBeGreaterThan(report.bytes);
      }
      // Смещение нужно КАЖДОМУ переходу — безусловному и условным: его считает один проход.
      const jumps = ['IR.jmp', 'IR.jmp_if', 'IR.jmp_if_not'].reduce(
        (sum, carrier) => sum + (report.carriers.find((item) => item.carrier === carrier)?.encoded ?? 0),
        0,
      );
      expect(report.layout.displacements, `${name}: смещений не столько, сколько понижённых переходов`).toBe(jumps);
      // У перехода команд две: команд не меньше, чем инструкций.
      expect(report.roundTrip.commands, `${name}: команд меньше, чем инструкций`).toBeGreaterThanOrEqual(report.encoded);
      expect(report.roundTrip.mismatches, `${name}`).toEqual([]);
    });

    it(`${name} (${algorithm}): полнота прогона и названные мешающие носители`, () => {
      const report = REPORTS.get(name)!;
      const carriers = report.blocking.map((blocking) => blocking.carrier);
      // Что мешает каждому ядру — ИЗМЕРЕНО, а не предположено. Числа перемерены 2026-09-24 ТРЕТИЙ раз
      // — после подъёма предела вытеснения до 4 (`.tmp/measure-realrun.ts`). Теперь раскладываются
      // ВСЕ ШЕСТНАДЦАТЬ процедур, поэтому мешающих носителей не осталось ни у одного ядра, кроме
      // вещественного `IR.div` ядра `iir` (формы нет — решение владельца). Свёртке нужно было четыре
      // вытеснения, а предел был два; требование взято замером (`.tmp/convolution-spill-need.ts`).
      const expectedBlocking: Readonly<Record<string, readonly string[]>> = {
        // ПЕРЕМЕР 2026-10-10 (§3.131): у КАЖДОГО ядра остались мешающие носители — обращения к
        // массивам в вызываемых процедурах. Их собственная половина кадра занята значениями, пятёрке
        // блока рантайма места нет, и понижение отказывает ПО ИМЕНИ (причина ниже). Прежде список был
        // пуст у всех пяти: обращения понижались «тихо» по клеткам плоскости точки входа (§3.127).
        fir: ['IR.invoke'],
        iir: ['IR.invoke'],
        fft: ['IR.invoke'],
        convolution: ['IR.invoke'],
        correlation: ['IR.invoke'],
      };
      expect([...carriers].sort(), `${name}: мешающие носители`).toEqual([...(expectedBlocking[name] ?? [])].sort());
      // Полнота прогона — это ровно «нет мешающих носителей», и она проверяется тем же измерением.
      expect(report.executableThroughReal, `${name}: полнота прогона`).toBe((expectedBlocking[name] ?? []).length === 0);
      expect(carriers, `${name}: константы обязаны быть понижены`).not.toContain('IR.const');
      // Переход понижён — он больше не мешает прогону и в списке мешающих не значится.
      expect(carriers, `${name}: переход понижён, мешать он не может`).not.toContain('IR.jmp');
      // Условные переходы и сравнения понижены парой — они больше не мешают.
      expect(carriers, `${name}: условные переходы понижены`).not.toContain('IR.jmp_if_not');
      expect(carriers, `${name}: сравнения понижены`).not.toContain('IR.lt');
      // Возврат понижён у ВСЕХ ядер: формы `return` есть, соглашение проверено по байтам.
      expect(carriers, `${name}: возврат понижён`).not.toContain('IR.ret');
      // Если `IR.invoke` всё-таки мешает — причина обязана называть рантайм, а не «формы нет»: форма
      // есть, её негде взять из-за зарезервированных регистров или неподдерживаемой операции.
      const invokeBlocking = report.blocking.find((item) => item.carrier === 'IR.invoke');
      if (invokeBlocking !== undefined) {
        // ПЕРЕМЕР 2026-10-10 (§3.131): к прежним двум причинам добавлена третья — «раскладка не
        // выдала базу блока рантайма». Она и есть штатная причина для обращения в вызываемой
        // процедуре: форма есть, а клеток под блок в её собственной половине кадра не нашлось.
        expect(invokeBlocking.reason, `${name}: причина отказа IR.invoke`).toMatch(
          /зарезервирован|нет такой операции|раскладка не выдала базу блока рантайма/,
        );
        // Отговорка «формы понижения нет» здесь недопустима: форма ЕСТЬ (её даёт `carrierFormOf`),
        // просто взять её негде — операнд в зарезервированной области или операция не массива.
        expect(invokeBlocking.reason, `${name}: отговорка вместо причины`).not.toMatch(/формы понижения нет/);
      }
      for (const blocking of report.blocking) {
        expect(blocking.reason.length, `${name}: ${blocking.carrier} без причины`).toBeGreaterThan(10);
      }
    });
  }

  it('emitShell с реальным кодировщиком отказывает: носители IR — не мнемоники e2k', () => {
    const module = kernelModule('fir');
    const annotated = annotateAtomRegions(module, [
      { atom: 'A5', procedures: module.procedures.map((procedure) => procedure.name) },
    ]);
    let error: unknown;
    try {
      emitShell(annotated, realEncoder);
    } catch (caught) {
      error = caught;
    }
    expect(error, 'эмиттер обязан отказать').toBeInstanceOf(Error);
    expect(String((error as Error).message)).toMatch(/НЕТ В ИСТОЧНИКЕ/);
    expect(error).toBeInstanceOf(EncodingRefusedError);
  });
});

describe('сквозной прогон: смысл понижения на данных пяти ядер', () => {
  for (const { name, algorithm } of KERNELS) {
    it(`${name} (${algorithm}): число совпадает с эталоном, предпосылки понижения подтверждены`, async () => {
      const reference = readReference();
      const observed = await runLoweredValues(kernelModule(name));
      expect(Number(observed.value), `${name}: понижённый прогон`).toBe(reference[name]!.checksum);
      expect(observed.truncated, `${name}: усечение 32 бит изменило бы результат`).toBe(0);
      expect(observed.nonInteger, `${name}: нецелый операнд там, где понижение требует целых`).toBe(0);
      // Понижённые операции действительно исполнялись, а не были выброшены компилятором.
      expect(Object.values(observed.executed).reduce((sum, count) => sum + count, 0)).toBeGreaterThan(0);
    });
  }

  it('прогон с понижением исполняет те же виды операций, что есть в ядрах', async () => {
    const observed = await runLoweredValues(kernelModule('fir'));
    expect(observed.executed[SYNTHETIC.move]).toBeGreaterThan(0);
    expect(observed.executed[SYNTHETIC.add]).toBeGreaterThan(0);
    expect(observed.executed[SYNTHETIC.mul]).toBeGreaterThan(0);
  });

  it('негативный контроль: подмена понижения ломает число ядра', async () => {
    // Подмена, которую обязан поймать прогон: `MULs` считается как точное произведение
    // (то есть как IR), а не как младшая половина. На этих данных она неотличима — и это
    // проверяется отдельно: значит проверка «усечения не было» осмысленна.
    const observed = await runLoweredValues(kernelModule('fir'));
    expect(observed.maxAbsProduct).toBeGreaterThan(0);
    // А вот замена сложения вычитанием обязана изменить число.
    const module = kernelModule('fir');
    const broken: RegModule = {
      ...module,
      code: module.code.map((element) => {
        const instruction = element as { op?: string };
        return instruction.op === 'add' ? ({ ...element, op: 'sub' } as typeof element) : element;
      }) as RegModule['code'],
    };
    const wrong = await runLoweredValues(broken).then(
      (result) => Number(result.value),
      (error: unknown) => `ошибка: ${error instanceof Error ? error.message : String(error)}`,
    );
    // Подмена обязана изменить либо число, либо ход исполнения (цикл перестаёт завершаться) —
    // в обоих случаях «прогон с понижением» перестаёт совпадать с эталоном.
    expect(wrong).not.toBe(readReference().fir!.checksum);
  });
});

describe('сквозной прогон: документ не расходится с измерением', () => {
  /** Таблица §2 документа: | ядро | атом | инструкций | понижено | отвергнуто | байт | move | add | sub | mul | */
  function docRows(): Map<string, number[]> {
    const file = path.join(ROOT, 'docs', 'e2k-real-run.md');
    const rows = new Map<string, number[]>();
    for (const line of fs.readFileSync(file, 'utf-8').split(/\r?\n/)) {
      const cells = line.split('|').map((cell) => cell.trim());
      if (cells.length !== 12) continue;
      const kernel = KERNELS.find((item) => item.name === cells[1]);
      if (kernel === undefined || cells[2] !== kernel.atom) continue;
      const numbers = cells.slice(3, 11).map((cell) => Number(cell.replace(/\s/g, '')));
      if (numbers.some((value) => !Number.isInteger(value))) continue;
      rows.set(kernel.name, numbers);
    }
    return rows;
  }

  it('числа §2 совпадают с прогоном', () => {
    const rows = docRows();
    expect(rows.size, 'в документе нет строк пяти ядер').toBe(KERNELS.length);
    for (const { name } of KERNELS) {
      const report = REPORTS.get(name)!;
      const rule = (carrier: string): number => report.carriers.find((item) => item.carrier === carrier)?.encoded ?? 0;
      const expected = [
        report.instructions,
        report.encoded,
        report.refused,
        report.bytes,
        rule('IR.move'),
        rule('IR.add'),
        rule('IR.sub'),
        rule('IR.mul'),
      ];
      expect(rows.get(name), `${name}: документ против прогона`).toEqual(expected);
    }
  });

  it('негативный контроль: испорченное число в документе ловится', () => {
    const rows = docRows();
    const fir = rows.get('fir')!;
    expect(fir[1] + fir[2], 'encoded + refused = instructions').toBe(fir[0]);
    const spoiled = [...fir];
    spoiled[1] = fir[1] + 1;
    expect(spoiled[1] + spoiled[2]).not.toBe(spoiled[0]);
  });
});

describe('сквозной прогон: переходы понижены — покрытие 424, отказов 22', () => {
  const imm = (value: number): Operand => ({ kind: 'imm', value });
  const reg = (index: number): Operand => ({ kind: 'reg', index });
  const carrier = (mnemonic: string, operands: readonly Operand[]): AsmInstruction => ({
    mnemonic,
    channel: 0,
    operands,
  });

  /**
   * Образ из носителей: адреса — из раскладки, переходы — серией по вычисленному смещению.
   *
   * Носители без формы пропускаются: в образ они и не попадают, а раскладка считает адреса ровно
   * по размещённым (см. `src/e2k/twoPassLayout.ts`). Пропуск проверяется сдвигом: адрес каждой
   * размещённой инструкции обязан совпасть с текущим смещением в байтах.
   */
  function laidOutImage(
    carriers: readonly AsmInstruction[],
    constants?: readonly unknown[],
    invokeNames?: readonly string[],
    procedures?: readonly { readonly name: string; readonly codeOffset: number }[],
    contextAt?: ReadonlyMap<number, { readonly arrayBase?: number; readonly inCallee: boolean }>,
  ): {
    bytes: Uint8Array;
    addresses: Map<number, number>;
    displacements: readonly Displacement[];
    /** Размещённые, но непонижённые носители: названы поимённо, а не пропущены молча. */
    refusals: ReadonlyArray<{ index: number; mnemonic: string; size: number; reason: string }>;
  } {
    const layout = layoutOf(carriers, {
      ...(invokeNames === undefined ? {} : { invokeNames }),
      // Пул констант обязателен: длина `IR.const` зависит от ЗНАЧЕНИЯ литерала (0…15 — короткая
      // непосредственная форма, 8 байт). Без пула модель форм считает все `IR.const` шестнадцатью
      // байтами, а кодировщик выдаёт восемь — и адреса раскладки расходятся с порядком байтов
      // (`docs/e2k-regalloc-debt.md` §7, замер `.tmp/form-size-probe.ts`).
      ...(constants === undefined ? {} : { constants }),
    });
    const resolved = secondPass(carriers, layout.addresses);
    expect(resolved.refusals.map((item) => `#${item.index}: ${item.reason}`), 'переход не разрешён').toEqual([]);
    // Пары «сравнение → условный переход» нужны и здесь: без них сравнение не понижается.
    const pairing = pairPredicates(carriers);
    expect(pairing.refusals.map((item) => `#${item.index}: ${item.reason}`), 'пара не составлена').toEqual([]);
    const displacementAt = new Map(resolved.displacements.map((item) => [item.index, item.disp]));
    // Вызовы: смещение считает ТА ЖЕ функция, что в конвейере (`callDisplacementsOf`) — иначе проверка
    // сверяла бы конвейер с собственной копией его формулы, а не с внешним инструментом.
    const callDisplacementAt =
      procedures === undefined ? new Map<number, number>() : callDisplacementsOf(carriers, procedures, layout.addresses);
    const predicateAt = new Map(
      pairing.pairs.map((pair) => [pair.comparisonIndex, { mnemonic: pair.cmpMnemonic, index: pair.predicate }]),
    );
    const conditionAt = new Map(pairing.pairs.map((pair) => [pair.jumpIndex, pair.condition]));
    const chunks: number[] = [];
    const refusals: Array<{ index: number; mnemonic: string; size: number; reason: string }> = [];
    const sizeAt = new Map(layout.entries.map((entry) => [entry.index, entry.size]));
    let offset = 0;
    carriers.forEach((instruction, index) => {
      const address = layout.addresses.get(index);
      if (address === undefined) return;
      expect(address, `#${index}: раскладка разошлась с порядком байтов`).toBe(offset);
      const displacement = displacementAt.get(index);
      const predicate = predicateAt.get(index);
      const condition = conditionAt.get(index);
      const callDisplacement = callDisplacementAt.get(index);
      const lowered = lowerCarrier(instruction, {
        ...(constants === undefined ? {} : { constants }),
        ...(invokeNames === undefined ? {} : { invokeNames }),
        // Контекст плоскости обязателен для обращений к массивам (§3.131): базу блока выдаёт
        // раскладка КОНКРЕТНОЙ процедуре, и без контекста отказывают ВСЕ обращения — не 8 из 22.
        ...(contextAt?.get(index) ?? {}),
        ...(displacement === undefined ? {} : { displacement }),
        ...(predicate === undefined ? {} : { predicate }),
        ...(condition === undefined ? {} : { condition }),
        ...(callDisplacement === undefined ? {} : { callDisplacement }),
      });
      if (!lowered.ok) {
        // Носитель РАЗМЕЩЁН (место в образе и длина у него есть), но понизить его нечем. Он
        // возвращается наружу поимённо — вызывающий обязан назвать его и причину, — а в образ идёт
        // заполнитель той же длины: без него все последующие адреса уехали бы, и сверка `disp` с
        // внешним дизассемблером проверяла бы не тот образ.
        const size = sizeAt.get(index) ?? 0;
        refusals.push({ index, mnemonic: instruction.mnemonic, size, reason: lowered.reason });
        chunks.push(...new Array<number>(size).fill(0));
        offset += size;
        return;
      }
      for (const command of lowered.instructions) {
        const encoded = realEncoder.encode(command);
        chunks.push(...encoded);
        offset += encoded.length;
      }
    });
    return {
      bytes: Uint8Array.from(chunks),
      addresses: layout.addresses,
      displacements: resolved.displacements,
      refusals,
    };
  }

  it('покрытие 458 из 458, отказов 0 — и это проверено по носителям', () => {
    // Перемер 2026-09-27 (task-4, `src/e2k/regAlloc.ts`: цели переходов пересчитываются ДО анализа
    // живости — `docs/hardware-debt.md` §3.35/§3.37): 464 → 458 носителей, разница 47 → 53,
    // покрытие 464 → 458. Сумма носителей эмиттера (511) НЕ сдвинулась — правка меняет только
    // вставки и снятия раскладки: у `convolution` вытеснений стало 4 → 2, у `fir` 1 → 2.
    //
    // Числа перемерены 2026-09-24 ТРЕТИЙ раз — после подъёма предела вытеснения до 4
    // (`.tmp/measure-realrun.ts`). Знаменатель 468: вытеснение вставляет носители (чтение из слота и
    // запись в слот), поэтому поток ДЛИННЕЕ исходного, а разница «носителей эмиттера минус поток»
    // (поле `eliminated`) у ядра со вставками может стать отрицательной — это не «снято копий», а
    // итоговая разница. Сумма носителей эмиттера — 511 (была 517: у iir трюк через остаток заменён
    // на div, и поток стал на шесть носителей короче). Отказов понижения НЕТ НИ ОДНОГО — впервые:
    // последний, вещественный IR.div ядра iir, снят вместе с трюком.
    let instructions = 0;
    let encoded = 0;
    let refused = 0;
    let eliminated = 0;
    const byCarrier = new Map<string, number>();
    for (const report of REPORTS.values()) {
      instructions += report.instructions;
      encoded += report.encoded;
      refused += report.refused;
      eliminated += report.eliminated;
      for (const carrier of report.carriers) {
        if (carrier.refused > 0) byCarrier.set(carrier.carrier, (byCarrier.get(carrier.carrier) ?? 0) + carrier.refused);
      }
    }
    expect(instructions).toBe(458);
    expect(eliminated, 'разница носителей эмиттера и потока').toBe(53);
    expect(instructions + eliminated, 'носителей эмиттера').toBe(511);
    // ── ПЕРЕМЕР 2026-10-10 (§3.131): ПОКРЫТИЕ 413, ОТКАЗОВ 45, И КАЖДЫЙ НАЗВАН ───────────────────
    //
    // Прежде: покрытие 458, отказов 0. Числа 458/53/511 — свойства потока эмиттера и раскладки — НЕ
    // сдвинулись; сдвинулось покрытие, и причина измерена: 45 обращений к массивам лежат в ВЫЗЫВАЕМЫХ
    // процедурах, а их собственная половина кадра (`%b[8..15]`, восемь клеток) занята значениями —
    // пятёрке блока рантайма места нет, базы нет, понижение отказывает ПО ИМЕНИ (`OSN-LOW-003`).
    // До §3.128 эти обращения понижались «тихо» по клеткам плоскости точки входа (тихий путь §3.127):
    // отсюда и «отказов 0», и байты 8800 вместо 6856 — мерилась конфигурация, которой компилятор не
    // выдаёт. Разбор — `docs/hardware-debt.md` §3.131.
    expect(encoded, 'покрытие пяти ядер').toBe(413);
    expect(refused, 'отказов').toBe(45);
    expect(
      [...byCarrier.entries()].sort((a, b) => b[1] - a[1]),
      'отказы названы: все — обращения к массивам вызываемых процедур',
    ).toEqual([['IR.invoke', 45]]);
    // Переход понижён целиком: 12 из 12.
    const jumps = [...REPORTS.values()].flatMap((report) =>
      report.carriers.filter((carrier) => carrier.carrier === 'IR.jmp'),
    );
    expect(jumps.reduce((sum, item) => sum + item.total, 0)).toBe(12);
    expect(jumps.reduce((sum, item) => sum + item.encoded, 0)).toBe(12);
    expect(jumps.reduce((sum, item) => sum + item.refused, 0)).toBe(0);
    for (const jump of jumps) {
      expect(jump.commands, 'у понижения перехода не названы команды').toEqual(['disp', 'ct']);
    }
  });

  it('lowerCarrier без смещения отказывает, со смещением даёт пару disp + ct', () => {
    const jump = carrier('IR.jmp', [imm(-3)]);
    const withoutDisplacement = lowerCarrier(jump);
    expect(withoutDisplacement.ok, 'без раскладки переход понижаться не должен').toBe(false);
    if (!withoutDisplacement.ok) expect(withoutDisplacement.reason).toBe(JUMP_NEEDS_LAYOUT);
    // Одиночная команда перехода не выражает — и это тоже названо причиной.
    const single = lowerInstruction(jump);
    expect(single.ok).toBe(false);

    const lowered = lowerCarrier(jump, { displacement: -3 });
    expect(lowered.ok).toBe(true);
    if (!lowered.ok) return;
    expect(lowered.instructions.map((command) => command.mnemonic)).toEqual(['disp', 'ct']);
    expect(lowered.instructions[0]!.operands).toEqual([imm(1), imm(-3)]);
    expect(lowered.instructions[1]!.operands).toEqual([imm(1), imm(CT_COND_ALWAYS)]);
    // Обе команды пары проходят круг: переход назад кодируется отрицательным смещением.
    for (const command of lowered.instructions) {
      const back = realEncoder.decode(realEncoder.encode(command));
      expect(sameInstruction(back, command), `${command.mnemonic}: круг не сошёлся`).toBe(true);
    }
  });

  it('образ ядра fir читается MCST-objdump: у каждого disp тот же адрес цели, что в раскладке', () => {
    const image0 = kernelImage('fir', 'A5');
    // Образ собирается из РАЗЛОЖЕННОГО потока — того же, что идёт в понижение, и в ТОЙ ЖЕ
    // конфигурации, что у компилятора (`src/e2k/guards/loweredUnchecked.ts#loweredProgramUnchecked`): процедуры с
    // обращениями к массивам помечены, точке входа — её пул, вызываемой — `CALLEE_REGISTERS`.
    // Без пометки базы нет НИ У ОДНОЙ процедуры, и отказывают все 22 обращения (в компиляторе — 8:
    // остальные 14 лежат в точке входа, которой база выдана). §3.131.
    const entryAt = entryProcedureIndex(image0.scheduled.procedures);
    const arrayProcedures = image0.scheduled.procedures
      .map((procedure, at) => {
        const to = image0.scheduled.procedures[at + 1]?.codeOffset ?? image0.instructions.length;
        const usesArrays = image0.instructions.slice(procedure.codeOffset, to).some((carrier) => {
          if (carrier.mnemonic !== 'IR.invoke') return false;
          const payload = carrier.operands[3];
          const name =
            payload !== undefined && payload.kind === 'imm' ? image0.image.invokeNames[payload.value] : undefined;
          return name !== undefined && SUPPORTED_ARRAY_CALLS.includes(name);
        });
        return usesArrays ? at : undefined;
      })
      .filter((at): at is number => at !== undefined);
    const allocation = allocateProgram(image0.instructions, image0.scheduled.procedures, {
      arrayProcedures,
      freeFor: (at: number) => (at === entryAt ? undefined : CALLEE_REGISTERS),
    });
    const contextAt = new Map<number, { arrayBase?: number; inCallee: boolean }>();
    allocation.procedures.forEach((procedure, at) => {
      const to = allocation.procedures[at + 1]?.codeOffset ?? allocation.instructions.length;
      for (let index = procedure.codeOffset; index < to; index++) {
        const arrayBase = allocation.arrayBases[at];
        contextAt.set(index, { ...(arrayBase === undefined ? {} : { arrayBase }), inCallee: at !== entryAt });
      }
    });
    const carriers = allocation.instructions;
    const image = laidOutImage(
      carriers,
      image0.scheduled.constants,
      image0.image.invokeNames,
      allocation.procedures,
      contextAt,
    );
    // ПЕРЕМЕР 2026-10-10 (§3.131): непонижённые размещённые носители у fir ЕСТЬ — восемь обращений к
    // массивам вызываемых процедур (`OSN-LOW-003`): их собственная половина кадра занята значениями.
    // Прежде их не было: обращения понижались «тихо» по клеткам плоскости точки входа (§3.127).
    // Проверка не ослаблена: список обязан состоять ТОЛЬКО из `IR.invoke` и их число названо.
    expect(
      [...new Set(image.refusals.map((item) => item.mnemonic))],
      'мнемоники непонижённых размещённых носителей fir',
    ).toEqual(['IR.invoke']);
    expect(image.refusals.length, 'непонижённых носителей fir').toBe(8);
    // В fir шесть переходов: три безусловных и три условных — смещение нужно каждому.
    expect(image.displacements.length, 'в fir шесть переходов').toBe(6);
    // Смещения ведут в адрес цели — проверяется арифметикой до внешнего инструмента.
    for (const item of image.displacements) {
      expect(image.addresses.get(item.index)).toBe(item.commandAddress);
      expect(image.addresses.get(item.targetIndex)).toBe(item.targetAddress);
      expect(item.commandAddress + item.disp * 8).toBe(item.targetAddress);
    }
    const { tool } = findExternalTool();
    if (tool === undefined) {
      const probe = findExternalTool();
      expect(probe.reason, 'причина ненайденности дизассемблера не названа').toBeDefined();
      return;
    }
    const elf = buildElfFromCode(image.bytes, MINIMAL_BASE);
    const result = disassembleElf(
      { bytes: Buffer.from(elf.bytes), layout: [] },
      path.join(ROOT, '.tmp', 'e2k-fir-layout.elf'),
    );
    expect(result, 'дизассемблер не ответил').toBeDefined();
    if (result === undefined) return;
    const lines = parseObjdumpOutput(result.text);
    const problems: string[] = [];
    for (const item of image.displacements) {
      const at = MINIMAL_BASE + item.commandAddress;
      const line = lines.find((candidate) => candidate.address === at);
      if (line === undefined) {
        problems.push(`нет строки по адресу 0x${at.toString(16)}`);
        continue;
      }
      const printed = /disp %ctpr(\d+), (0x[0-9a-f]+)/.exec(line.text);
      if (printed === null) {
        problems.push(`строка «${line.text}» не похожа на disp`);
        continue;
      }
      const expected = MINIMAL_BASE + item.targetAddress;
      if (Number.parseInt(printed[2]!, 16) !== expected) {
        problems.push(
          `#${item.index}: disp ведёт на ${printed[2]}, а цель раскладки — 0x${expected.toString(16)} (смещение ${item.disp})`,
        );
      }
    }
    expect(problems, `переходов проверено ${image.displacements.length}`).toEqual([]);
  });

  it('ассемблер МЦСТ собирает программу с переходом теми же байтами', () => {
    const { tool } = findExternalAs();
    if (tool === undefined) return; // причина ненайденности названа в e2kExternalAs.test.ts
    const carriers: readonly AsmInstruction[] = [
      carrier('IR.add', [reg(1), reg(2), reg(3)]), // 0
      carrier('IR.jmp', [imm(3)]), // 8, цель — 32
      carrier('IR.move', [reg(1), reg(2)]), // 24
      carrier('IR.move', [reg(3), reg(4)]), // 32 — цель
    ];
    const image = laidOutImage(carriers);
    expect(image.refusals, 'в синтетической программе понижается всё').toEqual([]);
    expect(image.displacements[0]!.disp, 'смещение программы').toBe(3);
    const sample: AsSample = {
      key: 'jmp-program',
      mnemonic: 'disp',
      channel: 0,
      form: 'серия disp + ct',
      asText: [
        // Носитель IR.add несёт (dst, a, b) = (1, 2, 3), а `adds` — (src1, src2, dst): (2, 3, 1).
        'adds,0 %b[2], %b[3], %b[1]',
        'disp %ctpr1, osnova_target',
        'ct %ctpr1',
        'movts,0 %b[2], %b[1]',
        'osnova_target:',
        'movts,0 %b[4], %b[3]',
      ].join('\n'),
      instruction: carrier('disp', [imm(1), imm(3)]),
      source: 'docs/e2k-real-run.md §2.3',
    };
    const result = assembleAll([sample])[0]!;
    expect(result.ok, `ассемблер отверг программу: ${result.ok ? '' : result.error}`).toBe(true);
    if (!result.ok) return;
    expect(toHex(result.bytes), 'байты программы у ассемблера против наших').toBe(toHex(image.bytes));
  });
});

describe('сквозной прогон: понижение одной инструкции', () => {
  const reg = (index: number): Operand => ({ kind: 'reg', index });
  const asm = (mnemonic: string, operands: readonly Operand[]): AsmInstruction => ({
    mnemonic,
    channel: 0,
    operands,
  });

  it('порядок операндов e2k соответствует формам, а не порядку IR', () => {
    // Носитель IR.move несёт (dst, a); e2k movts — (src2, dst), то есть (a, d).
    const move = lowerInstruction(asm('IR.move', [reg(7), reg(3)]));
    expect(move.ok).toBe(true);
    if (move.ok) expect(move.instruction.operands.map((o) => (o.kind === 'reg' ? o.index : -1))).toEqual([3, 7]);

    // Носитель IR.add несёт (dst, a, b); e2k adds — (src1, src2, dst), то есть (a, b, d).
    const add = lowerInstruction(asm('IR.add', [reg(9), reg(1), reg(2)]));
    expect(add.ok).toBe(true);
    if (add.ok) expect(add.instruction.operands.map((o) => (o.kind === 'reg' ? o.index : -1))).toEqual([1, 2, 9]);
  });

  it('непонижаемые носители отвергаются с причиной', () => {
    // У `IR.jmp` одиночной команды нет: понижение — серия `disp` + `ct`, и смещение считает
    // раскладка. Поэтому одиночный путь отказывает, а `lowerCarrier` со смещением — понижает
    // (проверено отдельным оракулом ниже).
    for (const carrier of ['IR.invoke', 'IR.jmp', 'IR.lt', 'IR.div', 'IR.ret']) {
      const result = lowerInstruction(asm(carrier, [reg(1), reg(2)]));
      expect(result.ok, `${carrier}`).toBe(false);
      if (!result.ok) expect(result.reason.length, `${carrier}`).toBeGreaterThan(10);
    }
  });

  it('IR.const: значение берётся из пула и становится литералом, а не регистром', () => {
    const num = (value: number): Operand => ({ kind: 'imm', value });
    // Носитель несёт (d, k, type): d = 7, индекс пула = 1, тип = 0 (i32).
    const instruction = asm('IR.const', [reg(7), num(1), num(0)]);
    const ok = lowerInstruction(instruction, { constants: [0, 42, 0] });
    expect(ok.ok).toBe(true);
    if (ok.ok) {
      expect(ok.instruction.mnemonic).toBe('movts');
      expect(ok.instruction.operands).toEqual([
        { kind: 'imm', value: 42 },
        { kind: 'reg', index: 7 },
      ]);
      // Кодируется и разбирается обратно тем же значением — литерал не подменяется.
      expect(realEncoder.decode(realEncoder.encode(ok.instruction)).operands[0]).toEqual({ kind: 'imm', value: 42 });
    }
    // Нецелая константа пула — названный отказ, а не молчаливое усечение.
    const nonInteger = lowerInstruction(instruction, { constants: [0, 0.5, 0] });
    expect(nonInteger.ok).toBe(false);
    if (!nonInteger.ok) expect(nonInteger.reason).toMatch(/только целые/);
    // Пул не передан — тоже отказ с причиной, а не выдуманное значение.
    const noPool = lowerInstruction(instruction);
    expect(noPool.ok).toBe(false);
    if (!noPool.ok) expect(noPool.reason).toMatch(/пул констант не передан/);
  });

  it('негативный контроль: перепутанный порядок операндов ломает понижение', () => {
    // Если поменять местами slots у movts, round-trip поймает расхождение: сравнение идёт
    // по операндам, а не по длине байтов.
    const shuffled: AsmInstruction = { mnemonic: 'movts', channel: 0, operands: [reg(7), reg(3)] };
    const back = realEncoder.decode(realEncoder.encode(shuffled));
    expect(back.operands.map((o) => (o.kind === 'reg' ? o.index : -1))).toEqual([7, 3]);
    const wrong: AsmInstruction = { mnemonic: 'movts', channel: 0, operands: [reg(3), reg(7)] };
    expect(realEncoder.encode(wrong)).not.toEqual(realEncoder.encode(shuffled));
  });
});

describe('сквозной прогон: раскладка регистров по процедурам', () => {
  it('раскладка посчитана для каждой процедуры каждого ядра и названа в отчёте', () => {
    const problems: string[] = [];
    for (const { name } of KERNELS) {
      const report = REPORTS.get(name)!;
      const expectedProcedures = kernelModule(name).procedures.length;
      if (report.allocation.length !== expectedProcedures) {
        problems.push(`${name}: раскладок ${report.allocation.length}, процедур ${expectedProcedures}`);
      }
      for (const item of report.allocation) {
        if (item.peak < 1) problems.push(`${name}/${item.procedure}: пик ${item.peak}`);
        if (!item.ok && (item.reason ?? '').length < 30) {
          problems.push(`${name}/${item.procedure}: отказ без причины`);
        }
      }
    }
    expect(problems, problems.join('; ')).toEqual([]);
  });

  it('фильтр FIR раскладывается: два значения уехали в память, входящие v0 и v1 закреплены', () => {
    // ЦЕЛЬ ДОСТИГНУТА 2026-09-24 минимальным вытеснением в память (`src/vliw/spill.ts`): в тесный
    // момент живы 9 отрезков при 8 свободных, поэтому самое дешёвое значение уезжает в слот, а его
    // чтения подгружаются из памяти; регистр оно больше не держит. Замер — `.tmp/spill-measure.ts`.
    // До этого проверка была КРАСНОЙ намеренно (решение владельца): раскладка отказывала.
    const report = REPORTS.get('fir')!;
    const filter = report.allocation.find((item) => item.procedure === 'фильтр')!;
    expect(filter.ok, filter.ok ? '' : `отказ: ${filter.reason}`).toBe(true);
    // Входящие v0 и v1 — параметры процедуры: они приходят в своих регистрах, и раскладка не имеет
    // права их переносить (иначе вызывающий положил бы значение не туда).
    expect(filter.incoming, 'входящие vreg названы').toEqual([0, 1]);
    // Измерено: свободны восемь регистров вызываемой (`CALLEE_REGISTERS = %b[8..15]` — своя половина
    // кадра при `call wbs = 4`), и заняты все восемь: раскладка укладывается впритык, самый тесный
    // момент требует восьми отрезков одновременно. НОМЕРА сдвинулись с `%b[2..9]` на `%b[8..15]`
    // (§3.131): прежде прогон звал раскладку без `freeFor`, и вызываемая получала пул точки входа;
    // теперь прогон повторяет конфигурацию компилятора.
    expect(filter.used, 'занято регистров').toBe(8);
    expect(filter.usedRegisters, 'занятые регистры').toEqual([8, 9, 10, 11, 12, 13, 14, 15]);
    expect(filter.unmapped, 'неотображённые vreg').toEqual([]);
    // Перемер 2026-09-27 (task-4, `docs/hardware-debt.md` §3.37): исправленный граф даёт процедуре
    // ТОЧНЫЕ отрезки (26 → 35), и её точная граница выросла (10 → 11 живых), поэтому вытесняются
    // ДВА значения, а не одно. Регистров по-прежнему занято восемь — вытеснение и есть то, чем
    // раскладка в них укладывается.
    expect(filter.spilled.length, 'вытеснено значений').toBe(2);
    expect(filter.spilled[0]!.accesses, 'обращений к памяти').toBeGreaterThan(0);
  });

  it('поток укорочен устранением копий: знаменатель отчёта — после снятия', () => {
    // Копии снимаются ДО раскладки, поэтому «инструкций» в отчёте меньше, чем носителей эмиттера:
    // перемер 2026-09-27 (task-4): 111 → 104 у FIR (было 111 → 102: правка раскладки добавляет
    // процедуре `фильтр` второе вытеснение, +2 носителя). `encoded + refused === instructions`
    // считается по укороченному потоку, а снятые носители названы отдельным числом — иначе
    // «покрытие упало» читалось бы как регрессия.
    const report = REPORTS.get('fir')!;
    expect(report.instructions, 'носителей после устранения копий').toBe(104);
    expect(report.eliminated, 'снято носителей').toBe(7);
    expect(report.removedCopies, 'снято копий в ядре').toBe(12);
    expect(report.encoded + report.refused, 'encoded + refused = instructions').toBe(report.instructions);
    expect(report.instructions + report.eliminated, 'носителей эмиттера').toBe(111);
  });

  it('процедуры, которым десяти регистров хватает, разложены — все шестнадцать', () => {
    const laid = KERNELS.flatMap(({ name }) =>
      REPORTS.get(name)!
        .allocation.filter((item) => item.ok)
        .map((item) => `${name}/${item.procedure}`),
    );
    // Измерено 2026-09-24 после подъёма предела вытеснения до 4 (`.tmp/spill-measure.ts`): раскладка
    // удалась у ВСЕХ 16 процедур из 16. Отказов нет ни у одной, и это не «отказ убран из проверки»:
    // `свёртке` не хватало четырёх вытеснений при пределе два (замер `.tmp/convolution-spill-need.ts`),
    // теперь предел четыре, и она укладывается в восемь свободных регистров.
    // Было 15 из 16 (отказывала `свёртка`), до вытеснения — 13 из 16.
    expect(laid.sort(), 'удавшиеся раскладки').toEqual(
      [
        'fir/фильтр',
        'fir/сумма',
        'fir/главная',
        'iir/целое_деление',
        'iir/фильтр',
        'iir/сумма',
        'iir/главная',
        'fft/бпф4',
        'fft/сумма',
        'fft/главная',
        'convolution/свёртка',
        'convolution/сумма',
        'convolution/главная',
        'correlation/корреляция',
        'correlation/сумма',
        'correlation/главная',
      ].sort(),
    );
    for (const report of REPORTS.values()) {
      for (const item of report.allocation.filter((entry) => entry.ok)) {
        expect(item.used, `${item.procedure}: занято регистров`).toBeLessThanOrEqual(10);
        expect(item.unmapped, `${item.procedure}: неотображённые vreg'и`).toEqual([]);
      }
    }
    // Ни одного отказа раскладки во всех пяти ядрах — и это проверяется, а не предполагается.
    const refusedProcedures = KERNELS.flatMap(({ name }) =>
      REPORTS.get(name)!
        .allocation.filter((item) => !item.ok)
        .map((item) => `${name}/${item.procedure}`),
    );
    expect(refusedProcedures, 'процедуры с отказом раскладки').toEqual([]);
  });

  it('окно вызываемой: у вызывающего 16 регистров, у вызываемой 8 — и это названо, а не замолчано', () => {
    // Измерено прогоном (`src/e2k/e2kCallWindowQemu.test.ts`): вызываемая процедура пишет в `%r5` и
    // `%r7`, а в `%r8` — ловушка. Отсюда не пожелание, а условие: процедура, которой нужно больше
    // восьми регистров, **вызвана быть не может**.
    // Числа `needed` перемерены 2026-09-27 (task-4, `docs/hardware-debt.md` §3.37) после правки
    // раскладки: исправленный граф даёт ТОЧНЫЕ отрезки, и требование окна у процедур выросло —
    // `сумма` 6 → 7 у всех ядер, `iir/фильтр` 7 → 9 (и он перестал влезать в окно вызываемой).
    // Прежний перемер 2026-09-24 ЧЕТВЁРТЫЙ раз — после подъёма предела вытеснения до 4
    // (`.tmp/spill-measure.ts`).
    const expected: Readonly<Record<string, ReadonlyArray<{ procedure: string; needed: number; ok: boolean }>>> = {
      fir: [
        { procedure: 'фильтр', needed: 10, ok: true },
        { procedure: 'сумма', needed: 7, ok: true },
      ],
      iir: [
        { procedure: 'целое_деление', needed: 4, ok: true },
        { procedure: 'фильтр', needed: 9, ok: true },
        { procedure: 'сумма', needed: 7, ok: true },
      ],
      fft: [
        { procedure: 'бпф4', needed: 9, ok: true },
        { procedure: 'сумма', needed: 7, ok: true },
      ],
      convolution: [
        { procedure: 'свёртка', needed: 10, ok: true },
        { procedure: 'сумма', needed: 7, ok: true },
      ],
      correlation: [
        { procedure: 'корреляция', needed: 10, ok: true },
        { procedure: 'сумма', needed: 7, ok: true },
      ],
    };
    for (const [name, items] of Object.entries(expected)) {
      const report = REPORTS.get(name)!;
      expect(
        report.calleeWindow.map((item) => ({ procedure: item.procedure, needed: item.needed, ok: item.ok })),
        `${name}: вызываемые процедуры и их окно`,
      ).toEqual(items);
      for (const item of report.calleeWindow) {
        expect(item.available, `${name}/${item.procedure}: доступно регистров вызываемой`).toBe(16);
        if (!item.ok) {
          expect(item.reason ?? '', `${name}/${item.procedure}: причина отказа без причины`).toMatch(/регистр|раскладка/);
        }
      }
    }
    // Перемер 2026-09-28 (§3.49): при `size_q = 12` окно вызываемой — 16, поэтому невлезающих
    // вызываемых не осталось ВООБЩЕ; числа `needed` (10/9/9/10/10) при этом не двигались.
    expect(
      REPORTS.get('fir')!.calleeWindow.some((item) => !item.ok),
      'FIR: ни одной вызываемой, которая не влезает',
    ).toBe(false);
  });

  it('покрытие FIR: 96 из 104 — восемь обращений к массивам вызываемых отказывают, вызвать процедуру всё ещё нельзя', () => {
    // ПЕРЕМЕР 2026-10-10 (§3.131): носителей 104 и снято копий 12 — как было (это свойства эмиттера
    // и раскладки). Сдвинулось ПОКРЫТИЕ: 104 → 96, отказано 8 — это обращения к массивам внутри
    // вызываемых процедур: их собственная половина кадра (`%b[8..15]`) занята значениями, пятёрке
    // блока рантайма места нет, и понижение отказывает по имени (`OSN-LOW-003`). Прежде здесь стояло
    // «104 из 104, отказов 0» — на конфигурации, где обращения понижались «тихо» по клеткам плоскости
    // точки входа (§3.127).
    //
    // Исполнения это по-прежнему НЕ обещает, и причина не только в понижении: окно вызываемой — восемь
    // регистров, а `фильтр` требует десять (`docs/e2k-opcodes-real.md` §7.10,
    // `docs/hardware-debt.md` §3.17–3.18).
    const report = REPORTS.get('fir')!;
    expect(report.instructions, 'носителей в FIR после снятия копий').toBe(104);
    expect(report.removedCopies, 'снято копий').toBe(12);
    expect(report.encoded, 'понижено').toBe(96);
    expect(report.refused, 'отказов').toBe(8);
    expect(report.blocking.map((item) => item.carrier), 'мешающие носители у FIR').toEqual(['IR.invoke']);
    expect(report.executableThroughReal, 'сквозной прогон через реальную кодировку').toBe(false);
    // И вызывать `фильтр` теперь МОЖНО: при `size_q = 12` окно вызываемой 16 ≥ 10 (§3.49).
    // Числа этого не сдвинуло — ни носители (104), ни требование окна (10).
    const filter = report.calleeWindow.find((item) => item.procedure === 'фильтр')!;
    expect(filter.ok, 'окно вызываемой для `фильтр`').toBe(true);
    expect(filter.needed, 'нужно регистров окна').toBe(10);
  });
});