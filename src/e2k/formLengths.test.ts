/**
 * ОРАКУЛ: РАЗМЕРЫ ФОРМ РАСКЛАДКИ СОВПАДАЮТ С ДЛИНАМИ КОДИРОВЩИКА.
 *
 * # Что здесь проверяется
 *
 * Раскладка (`secondPass`) считает смещения переходов по **размерам форм** (`carrierFormOf`), а образ
 * собирается **кодировщиком**. Если эти два числа расходятся, переход уезжает мимо цели — и это не
 * теория: измерено (`.tmp/form-size-probe.ts`), что модель форм считала `IR.const` 16 байт, а
 * кодировщик после короткой непосредственной формы (`0xc0|N`) выдавал 8; у цикла обратный переход
 * уводил **за начало программы**, и программы с циклом перестали исполняться.
 *
 * Проверяется ИНВАРИАНТ, а не один случай: для каждого носителя потока сумма размеров из формы равна
 * сумме длин понижённых команд. Значение литерала берётся из пула — как в конвейере.
 *
 * Зависимости: только свои модули (без QEMU), поэтому оракул живёт в полном прогоне.
 */
import { describe, it, expect } from 'vitest';
import { getEncoder, type AsmInstruction } from './backend';
import { emitShell } from './emitterShell';
import { annotateAtomRegions } from '../compiler/atomRegions';
import { regModuleOf } from '../vliw/regOracle';
import { lowerCarrier } from './e2kRealRun';
import { carrierFormOf, layoutOf, secondPass } from './twoPassLayout';
import { pairPredicates } from './predicatePairing';
import { ENTRY_ARRAY_BASE } from './arrayRuntime';

const encoder = getEncoder('e2k');
const shellEncoder = getEncoder('internal-shell');

/** Программа с малыми (0…15) и большими литералами: короткая и литеральная формы в одном потоке. */
const PROGRAMS: ReadonlyArray<{ name: string; source: string }> = [
  {
    name: 'цикл со счётчиком (малые литералы)',
    source: ['процедура главная()', '  пусть i = 0', '  пока i < 5', '    i = i + 1', '  конец', '  вернуть i', 'конец'].join('\n'),
  },
  {
    name: 'большой литерал (литеральная форма)',
    source: ['процедура главная()', '  пусть a = 1000', '  пусть b = 2', '  вернуть a + b', 'конец'].join('\n'),
  },
  {
    name: 'массив из трёх литералов',
    source: ['процедура главная()', '  пусть a = [1, 2, 3]', '  вернуть система.массив.длина(a)', 'конец'].join('\n'),
  },
];

/** Расхождение размеров формы и длин кодировщика по всему потоку. */
function mismatches(source: string): string[] {
  const built = regModuleOf(source);
  if (built === null) throw new Error('программа не компилируется');
  const annotated = annotateAtomRegions(built.module, [
    { atom: 'A5', procedures: built.module.procedures.map((procedure) => procedure.name) },
  ]);
  const emitted = emitShell(annotated, shellEncoder);
  // БАЗА БЛОКА НАЗВАНА ЯВНО (§3.128): своего понижения без базы больше нет — оно отказывает
  // («обращение ушло бы в чужие клетки»), и тогда «длина кодировщика» стала бы `undefined` у всех
  // обращений к массиву, а оракул сравнивал бы число с пустотой. Здесь поток ещё НЕ разложен
  // (`allocateProgram` не зван), поэтому берётся измеренная база точки входа — те же клетки, что
  // берёт и форма (`forForm`), а длины команд от номера клетки не зависят: все клетки блока —
  // регистровые операнды одной формы (см. `carrierFormOf`, `src/e2k/twoPassLayout.ts`).
  const context = {
    constants: emitted.scheduled.constants,
    invokeNames: emitted.image.invokeNames,
    arrayBase: ENTRY_ARRAY_BASE,
  };
  const code: readonly AsmInstruction[] = emitted.instructions;
  const layout = layoutOf(code, { invokeNames: emitted.image.invokeNames, constants: emitted.scheduled.constants });
  const resolved = secondPass(code, layout.addresses);
  const pairing = pairPredicates(code);
  const predicateAt = new Map(pairing.pairs.map((pair) => [pair.comparisonIndex, { mnemonic: pair.cmpMnemonic, index: pair.predicate }]));
  const conditionAt = new Map(pairing.pairs.map((pair) => [pair.jumpIndex, pair.condition]));
  const displacementAt = new Map(resolved.displacements.map((item) => [item.index, item.disp]));

  const problems: string[] = [];
  let realOffset = 0;
  code.forEach((carrier, index) => {
    const form = carrierFormOf(carrier, { invokeNames: emitted.image.invokeNames, constants: emitted.scheduled.constants });
    const formSize = form === undefined ? undefined : form.commands.reduce((sum, command) => sum + command.size, 0);
    const lowered = lowerCarrier(carrier, {
      ...context,
      ...(displacementAt.get(index) === undefined ? {} : { displacement: displacementAt.get(index)! }),
      ...(predicateAt.get(index) === undefined ? {} : { predicate: predicateAt.get(index)! }),
      ...(conditionAt.get(index) === undefined ? {} : { condition: conditionAt.get(index)! }),
    });
    const realSize = lowered.ok ? lowered.instructions.reduce((sum, command) => sum + encoder.encode(command).length, 0) : undefined;
    if (formSize !== realSize) {
      problems.push(`#${index} ${carrier.mnemonic}: форма ${String(formSize)} б, кодировщик ${String(realSize)} б`);
    }
    const layoutAddress = layout.addresses.get(index);
    if (realSize !== undefined && layoutAddress !== realOffset) {
      problems.push(`#${index} ${carrier.mnemonic}: адрес раскладки ${String(layoutAddress)}, реальный ${String(realOffset)}`);
    }
    if (realSize !== undefined) realOffset += realSize;
  });
  return problems;
}

describe('модель форм раскладки = кодировщик (иначе переходы уезжают)', () => {
  it('малые литералы дают КОРОТКУЮ форму (8 байт), большие — литеральную (16)', () => {
    const small = regModuleOf(PROGRAMS[0]!.source)!;
    const smallEmitted = emitShell(
      annotateAtomRegions(small.module, [{ atom: 'A5', procedures: small.module.procedures.map((procedure) => procedure.name) }]),
      shellEncoder,
    );
    const constCarriers = smallEmitted.instructions.filter((carrier) => carrier.mnemonic === 'IR.const');
    expect(constCarriers.length, 'в программе со счётчиком есть IR.const').toBeGreaterThan(0);
    const sizes = constCarriers.map((carrier) => {
      const form = carrierFormOf(carrier, { invokeNames: smallEmitted.image.invokeNames, constants: smallEmitted.scheduled.constants });
      return form === undefined ? -1 : form.commands.reduce((sum, command) => sum + command.size, 0);
    });
    // Значения 0 и 5 (и предел 5) — все 0…15, то есть короткая форма.
    expect(new Set(sizes), 'все малые литералы — короткая непосредственная форма').toEqual(new Set([8]));
    // Без пула констант форма обязана честно вернуться к литеральной: значение неизвестно.
    const withoutPool = constCarriers.map((carrier) => {
      const form = carrierFormOf(carrier, { invokeNames: smallEmitted.image.invokeNames });
      return form === undefined ? -1 : form.commands.reduce((sum, command) => sum + command.size, 0);
    });
    expect(new Set(withoutPool), 'без пула констант — литеральная форма, и это не молчание').toEqual(new Set([16]));
  });

  for (const program of PROGRAMS) {
    it(`размеры форм совпадают с кодировщиком: ${program.name}`, () => {
      expect(mismatches(program.source)).toEqual([]);
    });
  }
});
