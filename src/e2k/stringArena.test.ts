/**
 * СКЛЕЙКА СВЕРХ СТАТИЧЕСКОГО БУФЕРА: РЕШЕНИЕ, НОСИТЕЛИ, ФОРМА И ПАРА ПРЕДИКАТОВ.
 *
 * # Что здесь утверждается — и чем это ловится
 *
 * 1. **Решение принимает ПЛАНИРОВАНИЕ, и граница — 20 байт.** Рядом стоят два случая, различающиеся
 *    ОДНИМ байтом: 19 + 1 = 20 (статический буфер) и 19 + 2 = 21 (арена). Различающая пара
 *    обязательна: без неё «арена есть» неотличимо от «арена всегда».
 * 2. **Блок арены берётся ровно под сумму байтов.** Не «с запасом» и не «по первой строке»: число в
 *    носителе выделения — это сумма, и ошибка здесь была бы тихой порчей соседнего блока.
 * 3. **В статический буфер сверх 20 байт не пишется ничего** — и буфера в образе вовсе нет, если все
 *    склейки ушли в арену (прежний отказ «переполнение» переехал на исчерпание арены).
 * 4. **ФОРМА СОВПАДАЕТ С ПОНИЖЕНИЕМ.** Раскладка считает длину сайта по форме
 *    (`src/e2k/twoPassLayout.ts`), образ собирается из команд понижения
 *    (`src/e2k/stringRuntime.ts#stringArenaCopyInstructions`): расхождение двигает адреса переходов
 *    (класс `docs/hardware-debt.md` §3.35).
 * 5. **ПАРА ПРЕДИКАТОВ СОСТАВЛЯЕТСЯ.** Носители арены обязаны быть знакомы разбору регистров
 *    (`src/e2k/predicatePairing.ts#registersOf`): незнакомый носитель — БАРЬЕР, и сравнение сайта
 *    получает «читателей» из последующих сайтов. Это не теория: восемь заходов пробы (§3.84–§3.86)
 *    держались ровно на этом, причина названа в §3.89.3.
 *
 * # Чего здесь НЕТ
 *
 * Прогона в модели: он в шлюзе (`src/e2k/arenaQemu.test.ts` — склейка 21 байта, 195 выделений и
 * отказ 231; `src/e2k/printPrimitivesQemu.test.ts` — расширенная граница буфера).
 */
import { describe, it, expect } from 'vitest';
import { getEncoder } from './backend';
import { defUseOf } from './liveness';
import { pairPredicates } from './predicatePairing';
import { carrierFormOf } from './twoPassLayout';
import { ARENA_ALLOC_CARRIER, ARENA_LIMIT_BASE, ARENA_POINTER_BASE } from './procedureCall';
import { ARENA_FLAG_REGISTER, arenaGroups, arenaSiteCarriers } from './arenaRuntime';
import { ARRAY_REGISTERS } from './arrayRuntime';
import { HEAP_OFFSET } from './programImage';
import { MINIMAL_BASE } from './elfMinimal';
import { loweredProgram } from './programImage';
import { planStrings } from './stringPlan';
import {
  STRING_ARENA_CONCAT_CARRIER,
  STRING_ARENA_COPY_CARRIER,
  STRING_BUFFER_BYTES,
  STRING_CALLS,
  STRING_REGISTERS,
  concatFitsBuffer,
  stringArenaCopyInstructions,
} from './stringRuntime';

const encoder = getEncoder('e2k');
const encodedBytes = (instructions: readonly { mnemonic: string; channel: number; operands: readonly unknown[] }[]): number =>
  instructions.reduce((sum, instruction) => sum + encoder.encode(instruction as never).length, 0);

const reg = (index: number): { kind: 'reg'; index: number } => ({ kind: 'reg', index });
const imm = (value: number): { kind: 'imm'; value: number } => ({ kind: 'imm', value });
const carrier = (
  mnemonic: string,
  operands: readonly unknown[],
): { mnemonic: string; channel: number; operands: readonly unknown[] } => ({ mnemonic, channel: 0, operands });

/** Поток носителей со склейкой ДВУХ литералов: длины заданы строками пула, а не руками. */
const concatCode = (first: string, second: string): { code: readonly never[]; constants: readonly string[] } => ({
  code: [
    carrier('IR.const', [reg(0), imm(0)]),
    carrier('IR.const', [reg(1), imm(1)]),
    // `IR.invoke`: операнд 0 — флаги (5 = два аргумента и приёмник), 3 — имя вызова, 4 — приёмник.
    carrier('IR.invoke', [imm(5), reg(0), reg(1), imm(0), reg(2), imm(0)]),
    carrier('IR.ret', [imm(0), reg(0)]),
  ] as never[],
  constants: [first, second],
});

const planOf = (first: string, second: string) =>
  planStrings(concatCode(first, second).code, concatCode(first, second).constants, [STRING_CALLS.concat], MINIMAL_BASE + HEAP_OFFSET);

describe('склейка сверх статического буфера: решение и носители', () => {
  it('ГРАНИЦА: 20 байт — статика, 21 — арена; различает ОДИН байт', () => {
    expect(concatFitsBuffer(19, 1), 'ровно 20 — влезает').toBe(true);
    expect(concatFitsBuffer(20, 0)).toBe(true);
    expect(concatFitsBuffer(19, 2), '21 — уже арена').toBe(false);
    expect(concatFitsBuffer(0, 0), 'пустое влезает').toBe(true);
    expect(concatFitsBuffer(STRING_BUFFER_BYTES, 1)).toBe(false);

    const statics = planOf('0123456789012345678', 'z'); // 19 + 1 = 20
    const arena = planOf('0123456789012345678', 'zz'); // 19 + 2 = 21
    expect(statics.counts.arenaConcats, '20 байт обязаны остаться статикой').toBe(0);
    expect(arena.counts.arenaConcats, '21 байт обязан уйти в арену').toBe(1);
    expect(arena.problems, 'переполнения буфера больше нет: отказ переехал на исчерпание арены').toEqual([]);
  });

  it('носитель сайта: приёмник тот же, а длины — РОВНО байты склеиваемых строк', () => {
    const plan = planOf('0123456789012345678', 'яя'); // 19 + 4 = 23 байта, 21 кодовая точка
    const site = plan.code.find((item) => item.mnemonic === STRING_ARENA_CONCAT_CARRIER);
    expect(site, 'сайт склейки обязан стать носителем арены').toBeDefined();
    expect(site?.operands[0]).toEqual(reg(0));
    expect(site?.operands[1]).toEqual(reg(1));
    expect(site?.operands[2], 'приёмник — тот же регистр, что был у операции').toEqual(reg(2));
    expect(site?.operands[3]).toEqual(imm(19));
    expect(site?.operands[4]).toEqual(imm(4));
  });

  it('СТАТИЧЕСКИЙ БУФЕР не объявляется, если все склейки ушли в арену — и объявляется на 20 байтах', () => {
    const arena = planOf('0123456789012345678', 'zz');
    const statics = planOf('0123456789012345678', 'z');
    const buffer = (plan: ReturnType<typeof planOf>): number | undefined =>
      plan.blobs.find((blob) => blob.bytes.length === STRING_BUFFER_BYTES)?.address;
    expect(buffer(arena), 'под арену статических 20 байт не платим').toBeUndefined();
    expect(statics.blobs.some((blob) => blob.bytes.length === STRING_BUFFER_BYTES), 'статика — платим').toBe(true);
    // НЕГАТИВНЫЙ КОНТРОЛЬ: у арены в блобах НЕТ и самих склеенных байтов — их собирают в рантайме.
    expect(arena.blobs.some((blob) => blob.bytes.length === 21), 'склейка в образ не кладётся').toBe(false);
  });

  it('РАСШИРЕНИЕ: сайт = выделение + предел + переход + копирование; блок отказа — по числу', () => {
    const plan = planOf('0123456789012345678', 'zz');
    const at = plan.code.findIndex((item) => item.mnemonic === STRING_ARENA_CONCAT_CARRIER);
    const groups = arenaGroups(plan.code, plan.invokeNames, 0);
    expect(groups.sites, 'явных вызовов выделения в этой программе нет').toBe(0);
    expect(groups.concatSites).toBe(1);
    // Индекс блока отказа: заведение (1) + поток + по 2 носителя на сайт выделения + по 3 на склейку.
    expect(groups.refusalIndex).toBe(1 + plan.code.length + 3 * groups.concatSites);
    const expanded = groups.groups.get(at);
    expect(expanded?.map((item) => item.mnemonic)).toEqual([
      ARENA_ALLOC_CARRIER,
      'IR.le',
      'IR.jmp_if_not',
      STRING_ARENA_COPY_CARRIER,
    ]);
    // Выделяется СУММА: 19 + 2 = 21. Не «сколько-нибудь» и не первая длина.
    expect(expanded?.[0]?.operands[0], 'размер выделения — сумма байтов').toEqual(imm(21));
    expect(expanded?.[1]?.operands, 'сравнение — как есть: ключ, указатель, предел').toEqual([
      reg(ARENA_FLAG_REGISTER),
      reg(ARENA_POINTER_BASE),
      reg(ARENA_LIMIT_BASE),
    ]);
    expect(expanded?.[2]?.operands[1], 'переход ведёт в блок отказа').toEqual(imm(groups.refusalIndex));
    // Копирование адресует БАЗОЙ тот же регистр, что выделение приняло: адрес уже в нём.
    expect(expanded?.[3]?.operands[2]).toEqual(expanded?.[0]?.operands[1]);
  });

  it('ФОРМА СОВПАДАЕТ С ПОНИЖЕНИЕМ: длина сайта копирования — по командам, а не по догадке', () => {
    const commands = stringArenaCopyInstructions({ first: 0, second: 1, base: 2, firstBytes: 19, secondBytes: 2 });
    const copyCarrier = carrier(STRING_ARENA_COPY_CARRIER, [reg(0), reg(1), reg(2), imm(19), imm(2)]);
    const form = carrierFormOf(copyCarrier as never);
    expect(form, 'у носителя копирования обязана быть форма').toBeDefined();
    const formBytes = form!.commands.reduce((sum, command) => sum + command.size, 0);
    expect(formBytes, 'форма = байты понижения БАЙТ В БАЙТ').toBe(encodedBytes(commands));
    expect(formBytes).toBeGreaterThan(0);
    // НЕГАТИВНЫЙ КОНТРОЛЬ: копирование 19+2 и 1+1 — РАЗНАЯ длина, значит форма читает длины, а не имя.
    const short = carrierFormOf(carrier(STRING_ARENA_COPY_CARRIER, [reg(0), reg(1), reg(2), imm(1), imm(1)]) as never);
    const shortBytes = short!.commands.reduce((sum, command) => sum + command.size, 0);
    expect(shortBytes).not.toBe(formBytes);
    // И носитель выделения с ЧИСЛОМ размера кодируется теми же командами, что объявляет его форма.
    const alloc = carrier(ARENA_ALLOC_CARRIER, [imm(21), reg(2)]);
    const allocForm = carrierFormOf(alloc as never);
    expect(
      allocForm!.commands.reduce((sum, command) => sum + command.size, 0),
      'выделение с числовым размером',
    ).toBeGreaterThan(0);
  });

  it('РЕГИСТРЫ: копирование названо и в живости, и в разборе пар — барьера нет', () => {
    const copyCarrier = carrier(STRING_ARENA_COPY_CARRIER, [reg(0), reg(1), reg(2), imm(19), imm(2)]);
    const info = defUseOf(copyCarrier as never);
    expect([...info.def].sort((a, b) => a - b), 'временные названы: %b[10], %b[11] и единица рантайма').toEqual([
      STRING_REGISTERS.first,
      STRING_REGISTERS.second,
      ARRAY_REGISTERS.one,
    ]);
    expect(info.use, 'читаются обе строки и регистр блока').toEqual([0, 1, 2]);
  });

  it('ПАРА ПРЕДИКАТОВ СОСТАВЛЯЕТСЯ при сайтах склейки — это и держало восемь заходов', () => {
    const plan = planOf('0123456789012345678', 'zz');
    const groups = arenaGroups(plan.code, plan.invokeNames, 0);
    const expanded = plan.code.flatMap((item, index) => groups.groups.get(index) ?? [item]);
    const pairing = pairPredicates(expanded as never);
    expect(pairing.refusals, 'причина отказа обязана молчать').toEqual([]);
    expect(pairing.pairs, 'сравнение предела обязано стать парой').toHaveLength(1);
    expect(pairing.pairs[0]?.cmpMnemonic, 'пара — как у корпуса: сравнение и отрицание предиката').toBeDefined();
    // Различающий контроль: два сайта склейки в одном потоке — ДВЕ пары, а не «первая съела вторую».
    const two = [
      ...expanded,
      ...arenaSiteCarriers(imm(16), reg(3), groups.refusalIndex),
      carrier('IR.ret', [imm(0), reg(0)]),
    ];
    const twice = pairPredicates(two as never);
    expect(twice.refusals, 'второй сайт обязан составить свою пару').toEqual([]);
    expect(twice.pairs).toHaveLength(2);
  });
});

/**
 * ГРАНИЦЫ, НАЗВАННЫЕ ТЕКСТОМ. Каждая — отказ с причиной, а не «не сработало»: программа с такой
 * склейкой обязана краснеть ДО прогона, и прогон здесь не нужен — понижение чистое.
 */
describe('склейка сверх буфера: границы названы, а не подразумеваются', () => {
  const program = (body: string): string => `процедура главная()\n${body}\nконец_процедуры\n`;
  const reasons = (source: string): string =>
    loweredProgram(source)
      .refused.map((item) => item.reason)
      .join(' | ');

  it('склейка знаком `+` идёт ТЕМ ЖЕ путём: 21 байт — арена, отказов нет', () => {
    // `+` со строками оболочка выдаёт носителем `IR.add` — у него приёмник ПЕРВЫЙ, и решение о
    // способе обязано быть тем же. Откажись здесь — «склейка сверх буфера» работала бы только у
    // вызова `объединить`, а `+` молча падал бы.
    const image = loweredProgram(program('  система.лог.вывести("0123456789012345678" + "zz")'));
    expect(image.refused.map((item) => item.reason).join(' | ')).toBe('');
    expect(image.arena.used, '`+` сверх буфера тоже берёт арену').toBe(true);
    const fits = loweredProgram(program('  система.лог.вывести("0123456789012345678" + "z")'));
    expect(fits.arena.used, 'а ровно двадцать байт — по-прежнему статика').toBe(false);
  });

  it('склейка сверх буфера В ВЫЗЫВАЕМОЙ ПРОЦЕДУРЕ — названный отказ', () => {
    const source =
      'процедура склеить(): Число\n' +
      '  вернуть система.строка.длина(система.строка.объединить("0123456789012345678", "zz"))\n' +
      'конец_процедуры\n\n' +
      program('  система.лог.вывести(склеить())');
    expect(reasons(source), 'причина обязана называть вызываемую процедуру').toMatch(/вызываем/iu);
  });

  it('склейка сверх буфера БЕЗ ПРИЁМНИКА — названный отказ планирования', () => {
    // Носитель без приёмника: арена выделяет блок В ПРИЁМНИК, и положить его некуда. Это отказ
    // ПЛАНА (числа и причина известны до раскладки), а не «нет формы».
    const plan = planStrings(
      [
        carrier('IR.const', [reg(0), imm(0)]),
        carrier('IR.const', [reg(1), imm(1)]),
        // Флаги 4 = два аргумента и НЕТ приёмника.
        carrier('IR.invoke', [imm(4), reg(0), reg(1), imm(0), imm(0), imm(0)]),
      ] as never[],
      ['0123456789012345678', 'zz'],
      [STRING_CALLS.concat],
      MINIMAL_BASE + HEAP_OFFSET,
    );
    expect(plan.problems.join(' | '), 'причина обязана называть приёмник').toMatch(/приёмник/iu);
    expect(plan.counts.arenaConcats, 'и склейка обязана быть сосчитана').toBe(1);
  });
});
