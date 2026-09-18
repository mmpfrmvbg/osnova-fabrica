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
import { layoutOf, secondPass, type Displacement } from './twoPassLayout';
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
  it('таблица понижения описывает пять операций и у каждой названа предпосылка', () => {
    expect(LOWERING.map((rule) => rule.carrier).sort()).toEqual([
      'IR.add',
      'IR.const',
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
      expect(report.blocking.length, `${name}: ни одного отказа — тогда прогон был бы полным`).toBeGreaterThan(0);
    });

    it(`${name} (${algorithm}): round-trip каждой понижённой инструкции проходит`, () => {
      const report = REPORTS.get(name)!;
      expect(report.roundTrip.checked, `${name}: сверять нечего`).toBe(report.encoded);
      expect(report.roundTrip.mismatches, `${name}`).toEqual([]);
    });

    it(`${name} (${algorithm}): раскладка и кодирование не расходятся`, () => {
      const report = REPORTS.get(name)!;
      // Раскладка считает адреса по таблице форм, кодировщик выдаёт байты: числа обязаны сойтись.
      expect(report.layout.placed, `${name}: размещено не столько, сколько понижено`).toBe(report.encoded);
      expect(report.layout.unplaced, `${name}: не размещено не столько, сколько отвергнуто`).toBe(report.refused);
      expect(report.layout.totalBytes, `${name}: сумма размеров раскладки против суммы байтов`).toBe(report.bytes);
      const jumps = report.carriers.find((carrier) => carrier.carrier === 'IR.jmp')?.encoded ?? 0;
      expect(report.layout.displacements, `${name}: смещений не столько, сколько понижённых переходов`).toBe(jumps);
      // У перехода команд две: команд не меньше, чем инструкций.
      expect(report.roundTrip.commands, `${name}: команд меньше, чем инструкций`).toBeGreaterThanOrEqual(report.encoded);
      expect(report.roundTrip.mismatches, `${name}`).toEqual([]);
    });

    it(`${name} (${algorithm}): полный сквозной прогон невозможен — названы мешающие носители`, () => {
      const report = REPORTS.get(name)!;
      expect(report.executableThroughReal, `${name}: неожиданно полный прогон`).toBe(false);
      const carriers = report.blocking.map((blocking) => blocking.carrier);
      expect(carriers, `${name}: не назван хост-вызов`).toContain('IR.invoke');
      // Константы подключены к понижению, упор сместился на пары «подготовка + возврат».
      expect(carriers, `${name}: не названы возвраты`).toContain('IR.ret');
      expect(carriers, `${name}: константы обязаны быть понижены`).not.toContain('IR.const');
      // Переход понижён — он больше не мешает прогону и в списке мешающих не значится.
      expect(carriers, `${name}: переход понижён, мешать он не может`).not.toContain('IR.jmp');
      expect(carriers, `${name}: условные переходы ещё не понижены`).toContain('IR.jmp_if_not');
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

describe('сквозной прогон: IR.jmp понижен — покрытие 358, отказов 159', () => {
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
  ): {
    bytes: Uint8Array;
    addresses: Map<number, number>;
    displacements: readonly Displacement[];
  } {
    const layout = layoutOf(carriers);
    const resolved = secondPass(carriers, layout.addresses);
    expect(resolved.refusals.map((item) => `#${item.index}: ${item.reason}`), 'переход не разрешён').toEqual([]);
    const displacementAt = new Map(resolved.displacements.map((item) => [item.index, item.disp]));
    const chunks: number[] = [];
    let offset = 0;
    carriers.forEach((instruction, index) => {
      const address = layout.addresses.get(index);
      if (address === undefined) return;
      expect(address, `#${index}: раскладка разошлась с порядком байтов`).toBe(offset);
      const displacement = displacementAt.get(index);
      const lowered = lowerCarrier(instruction, {
        ...(constants === undefined ? {} : { constants }),
        ...(displacement === undefined ? {} : { displacement }),
      });
      expect(lowered.ok, `#${index} ${instruction.mnemonic}: ${lowered.ok ? '' : lowered.reason}`).toBe(true);
      if (!lowered.ok) return;
      for (const command of lowered.instructions) {
        const encoded = realEncoder.encode(command);
        chunks.push(...encoded);
        offset += encoded.length;
      }
    });
    return { bytes: Uint8Array.from(chunks), addresses: layout.addresses, displacements: resolved.displacements };
  }

  it('покрытие 358 из 517, отказов 159 — и отказы разложены по носителям', () => {
    let instructions = 0;
    let encoded = 0;
    let refused = 0;
    const byCarrier = new Map<string, number>();
    for (const report of REPORTS.values()) {
      instructions += report.instructions;
      encoded += report.encoded;
      refused += report.refused;
      for (const carrier of report.carriers) {
        if (carrier.refused > 0) byCarrier.set(carrier.carrier, (byCarrier.get(carrier.carrier) ?? 0) + carrier.refused);
      }
    }
    expect(instructions).toBe(517);
    expect(encoded, 'покрытие пяти ядер').toBe(358);
    expect(refused, 'отказов').toBe(159);
    expect([...byCarrier.entries()].sort((a, b) => b[1] - a[1])).toEqual([
      ['IR.invoke', 87],
      ['IR.ret', 32],
      ['IR.jmp_if_not', 14],
      ['IR.lt', 12],
      ['IR.call', 11],
      ['IR.div', 1],
      ['IR.ge', 1],
      ['IR.le', 1],
    ]);
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

  it('образ ядра fir читается MCST-objdump: у disp тот же адрес цели, что в раскладке', () => {
    const image0 = kernelImage('fir', 'A5');
    const carriers = image0.instructions;
    const image = laidOutImage(carriers, image0.scheduled.constants);
    expect(image.displacements.length, 'в fir три перехода').toBe(3);
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
