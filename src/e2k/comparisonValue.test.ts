/**
 * K5-ФОРМА (срез A4-5а): ЗНАЧЕНИЕ СРАВНЕНИЯ — В РЕГИСТРЕ, А НЕ «ПРЕДИКАТ И ЕСТЬ ЗНАЧЕНИЕ».
 *
 * # Что здесь стережётся
 *
 * На e2k `cmp*` пишет **предикат** (`pdst[4:0]`), а не регистр: значения сравнения в регистре нет
 * вовсе. Поэтому `вернуть код >= 48 и код <= 57` (шесть строк из задания задачи 1 среза 5) не
 * понижалось — отказ `OSN-LOW-004`. Новая форма носителя кладёт булево значение в регистр **двумя
 * переносами под тем же предикатом**: `cmp*` + `movts 1` + `movts 0` (по 16 байт у переносов с
 * слогом-условием `CDS`). Для «перевёрнутых» условий (`ge`/`gt`/`ne` — отрицаний в наборе `cmp*` нет)
 * константы переставлены, потому что значение сравнения — ОТРИЦАНИЕ предиката.
 *
 * # Откуда эталон
 *
 * Байты сняты **ассемблером МЦСТ** (`as-new 2.41`, WSL, `/root/build-gas/gas/as-new`, 2026-10-29):
 *
 * ```
 * cmplesb,0 %b[2], %b[3], %pred0    → 01 01 00 04 e0 03 02 20
 * movts,0 1, %b[1] ? %pred0         → 11 00 01 04 01 c1 c0 60 00 00 00 00 00 00 60 04
 * movts,0 0, %b[1] ? ~%pred0        → 11 00 01 04 01 c0 c0 60 00 00 00 00 00 00 e0 04
 * ```
 *
 * Числа на модели сверяются с эталоном, посчитанным **ОТ РУКИ** (`50` в `[48..57]` → 1, `10` → 0),
 * а не с «модель согласна сама с собой» — правило 3 из `AGENTS.md` (согласие модели и железа уже один
 * раз подтвердило НЕВЕРНОЕ число).
 *
 * # Негативный контроль
 *
 * Подмена одного байта в переносе (значение `1` → `0`) **меняет число**: та же проба, те же длины,
 * те же смещения — и ответ другой. Без этого «проверка» не отличала бы «перенос несёт значение» от
 * «перенос ничего не решает».
 *
 * # Куда файл должен уехать (долг места, не проверки)
 *
 * Прогонные проверки спрашивают живой QEMU — по правилу случая 12 их место в `npm run gate:qemu`.
 * Списка `include` в `vitest.qemu.config.ts` эта задача не касается (границы письма), поэтому файл
 * живёт в общем прогоне, как `src/e2k/multipleReturns.test.ts`: без шима прогонные проверки выходят
 * досрочно, а детерминированные (байты, форма, отказы) спрашиваются всегда.
 */
import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { parseV3 } from '../compiler-v3/index';
import { loweredProgramUnchecked } from './guards/loweredUnchecked';
import { buildElfFromCode, MINIMAL_BASE, WRITE_ZONE_EXTRA_MEMORY } from './elfMinimal';
import { buildShim, runInQemu } from '../scripts/e2kQemuExec';
import { getEncoder, toHex, type AsmInstruction, type Operand } from './backend';
import { isMaterializingComparison, pairPredicates } from './predicatePairing';
import { layoutOf } from './twoPassLayout';
import { lowerCarrier } from './e2kRealRun';

const ФАЙЛ = 'проба.osnova';
const ROOT = path.resolve(__dirname, '..', '..');
const encoder = getEncoder('e2k');
const shim = buildShim();

const reg = (index: number): Operand => ({ kind: 'reg', index });
const imm = (value: number): Operand => ({ kind: 'imm', value });
const ir = (mnemonic: string, operands: readonly Operand[]): AsmInstruction => ({ mnemonic, channel: 0, operands });

/** Байты понижения — одной строкой, как их печатает `as`/`objdump`. */
function байты(commands: readonly AsmInstruction[]): string {
  return commands.map((command) => toHex(encoder.encode(command))).join(' ');
}

/** ПОТОК, ГДЕ ЗНАЧЕНИЕ СРАВНЕНИЯ НУЖНО КАК ЗНАЧЕНИЕ: сравнение, затем `IR.ret`, читающий результат. */
function потокЗначения(comparison: string): readonly AsmInstruction[] {
  return [ir(comparison, [reg(1), reg(2), reg(3)]), ir('IR.ret', [imm(1), reg(1)])];
}

const ИЗМЕРЕНО_LE = [
  '01 01 00 04 e0 03 02 20',
  '11 00 01 04 01 c1 c0 60 00 00 00 00 00 00 60 04',
  '11 00 01 04 01 c0 c0 60 00 00 00 00 00 00 e0 04',
].join(' ');
const ИЗМЕРЕНО_GE = [
  '01 01 00 04 c0 03 02 20',
  '11 00 01 04 01 c0 c0 60 00 00 00 00 00 00 60 04',
  '11 00 01 04 01 c1 c0 60 00 00 00 00 00 00 e0 04',
].join(' ');

describe('K5-форма: байты и длина — одно решение на форму и на понижение', () => {
  it('`IR.le`: сравнение + два переноса — БАЙТЫ совпали с ассемблером МЦСТ побайтово', () => {
    const поток = потокЗначения('IR.le');
    pairPredicates(поток);
    expect(isMaterializingComparison(поток[0]!), 'значение сравнения не материализуется').toBe(true);
    const итог = lowerCarrier(поток[0]!);
    expect(итог.ok, 'материализованное сравнение не понизилось').toBe(true);
    if (!итог.ok) return;
    expect(итог.instructions.length, 'у материализации три команды: сравнение и два переноса').toBe(3);
    expect(байты(итог.instructions), 'байты разошлись с ассемблером МЦСТ').toBe(ИЗМЕРЕНО_LE);
  });

  it('`IR.ge` (перевёрнутое условие): константы переносов ПЕРЕСТАВЛЕНЫ — значение = отрицание предиката', () => {
    const поток = потокЗначения('IR.ge');
    pairPredicates(поток);
    expect(isMaterializingComparison(поток[0]!), 'значение сравнения не материализуется').toBe(true);
    const итог = lowerCarrier(поток[0]!);
    expect(итог.ok).toBe(true);
    if (!итог.ok) return;
    expect(байты(итог.instructions), 'байты разошлись с ассемблером МЦСТ').toBe(ИЗМЕРЕНО_GE);
  });

  it('пара сохранена: то же понижение и с предикатом пары из сопоставления', () => {
    // Пара «сравнение → переход»: предикат приходит из контекста, а переносы обязаны читать ТОТ ЖЕ
    // предикат — иначе значение окажется от другого сравнения.
    const поток: readonly AsmInstruction[] = [
      ir('IR.lt', [reg(1), reg(2), reg(3)]),
      ir('IR.jmp_if_not', [reg(1), imm(2)]),
      ir('IR.ret', [imm(1), reg(1)]),
    ];
    const pairing = pairPredicates(поток);
    expect(pairing.refusals, 'отказов у пары со значением быть не должно').toEqual([]);
    expect(pairing.pairs.map((пара) => пара.comparisonIndex)).toEqual([0]);
    const итог = lowerCarrier(поток[0]!, { predicate: { mnemonic: 'cmplsb', index: 0 } });
    expect(итог.ok).toBe(true);
    if (!итог.ok) return;
    expect(итог.instructions.length).toBe(3);
    const предикаты = итог.instructions.slice(1).map((command) => command.operands[2]);
    expect(предикаты, 'переносы читают не тот предикат').toEqual([
      { kind: 'pred', index: 0 },
      { kind: 'pred', index: 0, negated: true },
    ]);
  });

  it('длина носителя = сумма трёх команд (раскладка не разошлась с байтами, §3.135)', () => {
    const поток = потокЗначения('IR.le');
    pairPredicates(поток);
    const итог = lowerCarrier(поток[0]!);
    expect(итог.ok).toBe(true);
    if (!итог.ok) return;
    const длинаБайтов = итог.instructions.reduce((sum, command) => sum + encoder.encode(command).length, 0);
    const layout = layoutOf(поток);
    const entry = layout.entries.find((item) => item.index === 0);
    expect(entry, 'носитель сравнения не размещён').toBeDefined();
    expect(entry!.commands.length, 'форма объявляет не три команды').toBe(3);
    expect(entry!.size, 'длина формы разошлась с длиной байтов').toBe(длинаБайтов);
    expect(entry!.size, 'длина материализации — 8 + 16 + 16').toBe(40);
  });

  it('без материализации форма ПРЕЖНЯЯ, 8 байт: закреплённые числа не двигаются', () => {
    // Значение мёртво (следующая же запись перекрывает регистр) — материализации нет.
    const поток: readonly AsmInstruction[] = [ir('IR.lt', [reg(1), reg(2), reg(3)]), ir('IR.const', [reg(1), imm(0)])];
    expect(pairPredicates(поток).refusals.length, 'форма без читателей — отказ, а не пара').toBeGreaterThan(0);
    expect(isMaterializingComparison(поток[0]!)).toBe(false);
    const layout = layoutOf(поток);
    expect(layout.entries.find((item) => item.index === 0)?.size, 'форма сравнения уехала').toBe(8);
  });
});

describe('K5-форма: шестистрочное репро из задания понижается', () => {
  const РЕПРО = [
    'процедура цифра(код: Число) → Логический',
    '  вернуть код >= 48 и код <= 57',
    'конец',
    'действие главная()',
    '  вернуть 0',
    'конец',
    '',
  ].join('\n');

  it('отказов 0, и образ не пуст', () => {
    const р = parseV3(РЕПРО, ФАЙЛ);
    expect(р.errors, 'разбор репро').toEqual([]);
    // Я СТОРОЖ, СМОТРЮ ПОД ОТКАЗОМ (D11): байты нужны ВМЕСТЕ с отказами — это дверь сторожей.
    const образ = loweredProgramUnchecked(РЕПРО, { filename: ФАЙЛ, parse: () => ({ ast: р.program ?? null, errors: р.errors }) });
    expect(образ.refused.map((отказ) => `${отказ.code}: ${отказ.reason}`), 'репро снова отказывает').toEqual([]);
    expect(образ.bytes.length, 'образ пуст').toBeGreaterThan(0);
  });
});

describe('K5-форма: модель — эталон посчитан ОТ РУКИ', () => {
  /** Образ кода программы без отказов (или `undefined`, если программа не собралась). */
  function образ(источник: string): Uint8Array | undefined {
    const р = parseV3(источник, ФАЙЛ);
    if (р.errors.length > 0) return undefined;
    // Я СТОРОЖ, СМОТРЮ ПОД ОТКАЗОМ (D11): байты нужны ВМЕСТЕ с отказами — это дверь сторожей.
    const собран = loweredProgramUnchecked(источник, { filename: ФАЙЛ, parse: () => ({ ast: р.program ?? null, errors: р.errors }) });
    if (собран.refused.length > 0) return undefined;
    return собран.bytes;
  }

  /** Код возврата гостя в модели; `undefined` — модель недоступна. */
  function модель(код: Uint8Array, имя: string): number | null | undefined {
    const файл = path.join(ROOT, '.tmp', `comparison-value-${имя}.elf`);
    fs.writeFileSync(файл, buildElfFromCode(код, MINIMAL_BASE, { writable: true, extraMemory: WRITE_ZONE_EXTRA_MEMORY }).bytes);
    return runInQemu(файл, { shim: true, timeoutMs: 20_000 })?.status;
  }

  const программа = (код: number, возврат: string): string =>
    ['действие главная()', `  пусть код = ${String(код)}`, `  вернуть ${возврат}`, 'конец', ''].join('\n');

  const пробы: readonly { readonly имя: string; readonly код: number; readonly возврат: string; readonly ожидание: number }[] = [
    { имя: 'в-диапазоне', код: 50, возврат: 'код >= 48 и код <= 57', ожидание: 1 },
    { имя: 'вне-диапазона', код: 10, возврат: 'код >= 48 и код <= 57', ожидание: 0 },
    { имя: 'левая-граница', код: 48, возврат: 'код >= 48 и код <= 57', ожидание: 1 },
    { имя: 'правая-граница', код: 57, возврат: 'код >= 48 и код <= 57', ожидание: 1 },
    { имя: 'левее-границы', код: 47, возврат: 'код >= 48 и код <= 57', ожидание: 0 },
    { имя: 'одно-сравнение-истинно', код: 50, возврат: 'код >= 48', ожидание: 1 },
    { имя: 'одно-сравнение-ложно', код: 10, возврат: 'код >= 48', ожидание: 0 },
    { имя: 'перевёрнутое-условие', код: 50, возврат: 'не (код >= 48)', ожидание: 0 },
  ];

  it('булево значение сравнения доехало числом: восемь проб, эталон — счёт от руки', () => {
    if (shim === undefined) {
      console.log('K5-форма: шим модели недоступен — прогонные проверки пропущены');
      return;
    }
    const беды: string[] = [];
    for (const проба of пробы) {
      const собран = образ(программа(проба.код, проба.возврат));
      if (собран === undefined) {
        беды.push(`${проба.имя}: не собралась`);
        continue;
      }
      const код = модель(собран, проба.имя);
      if (код !== проба.ожидание) беды.push(`${проба.имя}: модель ${String(код)}, эталон ${String(проба.ожидание)}`);
    }
    expect(беды, 'значение сравнения приехало не тем числом').toEqual([]);
  });

  it('НЕГАТИВНЫЙ КОНТРОЛЬ: подмена значения в переносе меняет число — проверка не молчит', () => {
    if (shim === undefined) {
      console.log('K5-форма: шим модели недоступен — негативный контроль пропущен');
      return;
    }
    const собран = образ(программа(50, 'код >= 48'));
    expect(собран, 'проба не собралась').toBeDefined();
    const целый = модель(собран!, 'целый');
    expect(целый, 'целый образ вернул не эталон').toBe(1);

    // Перенос «единицы» под ОТРИЦАНИЕМ предиката: HS `11 00 01 04`, значение `1` (`0xc1`) в поле
    // литерала, `opce` (`0xc0`), опкод `movts` (`0x60`), слог-условие `~%pred0` (`00 00 e0 04`).
    const испорченный = Uint8Array.from(собран!);
    const слова = (at: number, from: number, count: number): string =>
      [...испорченный.slice(at + from, at + from + count)].map((byte) => byte.toString(16).padStart(2, '0')).join(' ');
    const места: number[] = [];
    for (let at = 0; at + 16 <= испорченный.length; at++) {
      if (слова(at, 0, 4) !== '11 00 01 04') continue;
      if (слова(at, 5, 3) !== 'c1 c0 60') continue;
      if (слова(at, 12, 4) !== '00 00 e0 04') continue;
      места.push(at);
    }
    expect(места.length, 'перенос с единицей под отрицанием предиката не найден — контроль не сработал').toBe(1);
    испорченный[места[0]! + 5] = 0xc0; // значение 1 → 0
    const подменённый = модель(испорченный, 'испорченный');
    expect(подменённый, 'подмена значения НЕ изменила число — перенос не несёт значение').toBe(0);
  });
});
