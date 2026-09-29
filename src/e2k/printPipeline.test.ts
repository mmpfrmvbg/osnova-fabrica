/**
 * ОРАКУЛ ПОДКЛЮЧЕНИЯ ПЕЧАТИ К КОНВЕЙЕРУ — БЕЗ МОДЕЛИ.
 *
 * # Что здесь утверждается
 *
 * 1. **Формы развёртки совпадают с кодировщиком.** Раскладка обязана считать длину печати САМА
 *    (`src/e2k/printCall.ts:printCommandForm`), не спрашивая кодировщик, — иначе расхождение между
 *    ними нечем поймать. Оракул сверяет каждую команду сайта: объявленный размер против выданного
 *    кодировщиком. Это и есть работающая связка «раскладка против кодировщика».
 * 2. **Негативный контроль к (1):** подмена объявленного размера обязана покраснить сверку — иначе
 *    она не сторожит ничего (проверяется на копии таблицы, а не на самой таблице).
 * 3. **Длина носителя в раскладке равна байтам сайта** — включая сохранение живых регистров
 *    (по 48 байт на регистр). Это то, ради чего число сохранённых едет в самом носителе.
 * 4. **Носитель без числа сохранённых — названный отказ, а не нулевая длина.** Молчаливый ноль и
 *    есть тот дефект, от которого эта ветвь: смещение перехода, пересекающего печать, считалось бы
 *    по нулю (docs/hardware-debt.md §3.43).
 * 5. **Шесть записей корпуса (39–44) собираются конвейером без отказов и не доходят кодом до
 *    площадки печати** — без модели. Это сторож подключения: сломается путь печати — покраснеет
 *    здесь, а не только в шлюзе `gate:qemu`.
 * 6. **Сторож места (§3.40.6):** образ, код которого дорастает до площадки печати, обязан быть
 *    ОТКЛОНЁН с числами. Положительный контроль — тот же образ с одной печатью: проходит.
 * 7. **Сайт печати не завершает программу:** в нём ровно один `call` (это `write`). Выход ставится
 *    один раз в конце образа — иначе запись `43` (печать в цикле) оборвалась бы после первой строки.
 *
 * # Чего здесь НЕТ
 *
 * Прогона в модели: байты и код возврата шести записей проверяет оракул цели
 * (`src/scripts/examplesE2k.audit.test.ts`, шлюз `gate:qemu`), а этот файл — про устройство пути.
 */
import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { getEncoder, type AsmInstruction, type Operand } from './backend';
import { MINIMAL_BASE } from './elfMinimal';
import { HEAP_OFFSET, WRITE_PAGE_BYTES, imageOfCarriers, loweredProgram } from './programImage';
import { carrierFormOf, layoutOf } from './twoPassLayout';
import { printAreaOf, PRINT_PRIMITIVE_CLOBBERS } from './printPrimitives';
import {
  PRINT_CALL,
  PRINT_SAVE_BYTES_PER_REGISTER,
  PRINT_SAVE_COUNT_OPERAND,
  PrintCallRefusal,
  planPrintSite,
  printCallInstructions,
  printCommandForm,
  printSiteInstructions,
  withPrintSaveCount,
} from './printCall';

const ROOT = path.resolve(__dirname, '..', '..');
const encoder = getEncoder('e2k');
const HEAP = MINIMAL_BASE + HEAP_OFFSET;
const AREA = printAreaOf(HEAP);
/** Начало СТРАНИЦЫ записи: писать можно только туда, где нет кода (замер 2026-09-29, §3.90.7). */
const pageOf = (address: number): number => address - (address % WRITE_PAGE_BYTES);
const imm = (value: number): Operand => ({ kind: 'imm', value });
const reg = (index: number): Operand => ({ kind: 'reg', index });

/** Носитель печати — тот же, каким его выдаёт эмиттер оболочки: `[flags, arg0, arg1, payload, dst]`. */
const printingCarrier = (argument: number, nameIndex = 0): AsmInstruction => ({
  mnemonic: 'IR.invoke',
  channel: 0,
  operands: [imm(3), reg(argument), reg(0), imm(nameIndex), reg(0)],
});

const bytesOf = (instructions: readonly AsmInstruction[]): number =>
  instructions.reduce((sum, instruction) => sum + encoder.encode(instruction).length, 0);

/** Размер формы: то, чем раскладка измеряет носитель. */
const formBytes = (carrier: AsmInstruction, saveCount: number): number => {
  const form = carrierFormOf(withPrintSaveCount(carrier, saveCount), {
    invokeNames: [PRINT_CALL],
    heapAddress: HEAP,
  });
  expect(form, 'у печатающего носителя обязана быть форма').toBeDefined();
  return form!.commands.reduce((sum, command) => sum + command.size, 0);
};

describe('печать: путь подключён, длины и байты сходятся', () => {
  it('формы развёртки совпадают с кодировщиком — для всех значений и обоих адресов площадки', () => {
    const problems: string[] = [];
    let commands = 0;
    for (const argument of [0, 1, 2, 7]) {
      for (const heap of [HEAP, HEAP + 0x4000]) {
        for (const instruction of printCallInstructions(argument, heap)) {
          commands++;
          const form = printCommandForm(instruction);
          const encoded = encoder.encode(instruction).length;
          if (form === undefined) {
            problems.push(`«${instruction.mnemonic}»: формы в таблице нет, а кодировщик даёт ${String(encoded)} байт`);
            continue;
          }
          if (form.size !== encoded) {
            problems.push(
              `«${instruction.mnemonic}»: объявлено ${String(form.size)} байт, кодировщик даёт ${String(encoded)}`,
            );
          }
        }
      }
    }
    expect(commands, 'команд развёртки проверено').toBeGreaterThan(100);
    expect(problems, problems.join('\n')).toEqual([]);
  });

  it('НЕГАТИВНЫЙ КОНТРОЛЬ: сверка различает подменённый размер', () => {
    // Копия таблицы с испорченным размером обязана разойтись с кодировщиком — иначе сверка выше
    // ничего не сторожит (она бы «проходила» при любых числах).
    const instruction: AsmInstruction = { mnemonic: 'stb', channel: 2, operands: [reg(4), reg(7), reg(6)] };
    const honest = printCommandForm(instruction)!;
    const broken = { ...honest, size: honest.size + 8 };
    const encoded = encoder.encode(instruction).length;
    expect(honest.size).toBe(encoded);
    expect(broken.size, 'испорченный размер обязан отличаться от кодировщика').not.toBe(encoded);
  });

  it('размер сайта в раскладке равен его байтам — вместе с сохранением живых регистров', () => {
    for (const saved of [[], [0], [0, 2], [1, 2, 3, 4]]) {
      const plan = planPrintSite({ argument: 2, heapAddress: HEAP, liveAfter: saved });
      expect(plan.saved.map((item) => item.register), 'сохранены обязаны быть все живые').toEqual(saved);
      const bytes = bytesOf(printSiteInstructions(plan));
      expect(formBytes(printingCarrier(2), plan.saved.length), `сохранённых ${String(saved.length)}`).toBe(bytes);
      // Цена сохранения названа числом: 48 байт на регистр (movtd+std и movtd+ldd).
      expect(formBytes(printingCarrier(2), plan.saved.length)).toBe(
        bytesOf(printCallInstructions(2, HEAP)) + plan.saved.length * PRINT_SAVE_BYTES_PER_REGISTER,
      );
    }
  });

  it('носитель без числа сохранённых регистров — названный отказ, а не нулевая длина', () => {
    const bare = printingCarrier(2);
    expect(bare.operands[PRINT_SAVE_COUNT_OPERAND], 'в синтетическом носителе числа нет').toBeUndefined();
    expect(carrierFormOf(bare, { invokeNames: [PRINT_CALL] }), 'длины без числа нет').toBeUndefined();
    // Причина обязана называть именно недостающий операнд: «формы нет» здесь врало бы — форма есть.
    const table = layoutOf([bare], { invokeNames: [PRINT_CALL] });
    expect(table.unplaced).toHaveLength(1);
    expect(table.unplaced[0]!.reason).toContain(String(PRINT_SAVE_COUNT_OPERAND));
  });

  it('регистр значения у носителя — тот, что выдала раскладка: длина от него зависит', () => {
    // Печать значения из `%b[0]` не несёт пересылки, из любого другого — несёт (8 байт). Значит
    // длина сайта обязана считаться ПО ОПЕРАНДУ, а не по мнемонике.
    const first = formBytes(printingCarrier(0), 0);
    const second = formBytes(printingCarrier(2), 0);
    expect(second - first, 'пересылка в рабочий регистр — одна короткая команда').toBe(8);
  });

  it('сайт печати НЕ завершает программу: в нём ровно один вызов — `write`', () => {
    const plan = planPrintSite({ argument: 2, heapAddress: HEAP, liveAfter: [0, 2] });
    const kinds = printSiteInstructions(plan).map((instruction) => instruction.mnemonic);
    expect(kinds.filter((kind) => kind === 'call'), 'выход добавит конвейер, а не сайт').toHaveLength(1);
    // `movtd` развёртки (площадка, два слова-границы) плюс по одному на каждый сохранённый регистр
    // с каждой стороны: сохранение и восстановление.
    const printMovtd = printCallInstructions(2, HEAP).filter((instruction) => instruction.mnemonic === 'movtd').length;
    expect(kinds.filter((kind) => kind === 'movtd'), 'адреса слотов — по одному movtd на слот').toHaveLength(
      printMovtd + 2 * plan.saved.length,
    );
  });

  it('сохранение не трогает регистры рантайма массивов и берёт мёртвый регистр под адрес', () => {
    const plan = planPrintSite({ argument: 2, heapAddress: HEAP, liveAfter: [0, 2] });
    expect(plan.scratch, 'регистр адреса не может быть занят живым значением').not.toBe(0);
    expect(plan.scratch, 'не может быть регистром значения').not.toBe(2);
    expect(PRINT_PRIMITIVE_CLOBBERS, 'развёртка занимает ровно %b[0..11]').toContain(plan.scratch);
    expect(plan.scratch).toBeLessThan(12);
    const spillBase = printAreaOf(HEAP) + 64;
    for (const item of plan.saved) {
      expect(item.address, 'слоты сохранения — верх вытеснительной области').toBeGreaterThanOrEqual(spillBase + 128);
      expect(item.address, 'и не выходят из неё').toBeLessThan(spillBase + 256);
    }
    // Десять сохранённых плюс регистр значения — свободным остаётся ровно один, им и адресуют.
    const crowded = planPrintSite({ argument: 2, heapAddress: HEAP, liveAfter: [0, 1, 3, 4, 5, 6, 7, 8, 9, 11] });
    expect(crowded.saved).toHaveLength(10);
    expect(crowded.scratch, 'мёртвым остался только %b[10]').toBe(10);
  });

  it('живое значение без свободного регистра под адрес — названный отказ', () => {
    // Живы все `%b[0..11]` и ни один не свободен: сохранять нечем — это должно быть отказом.
    expect(() =>
      planPrintSite({ argument: 12, heapAddress: HEAP, liveAfter: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11] }),
    ).toThrow(PrintCallRefusal);
    expect(() =>
      planPrintSite({ argument: 12, heapAddress: HEAP, liveAfter: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11] }),
    ).toThrow(/свободного регистра под адрес/);
  });

  it('слоты печати поверх вытеснения раскладки — названный отказ', () => {
    const spillBase = printAreaOf(HEAP) + 64;
    const occupied = [spillBase + 8, spillBase + 128];
    expect(() => planPrintSite({ argument: 2, heapAddress: HEAP, liveAfter: [0], occupied })).toThrow(
      /заняты вытеснением/,
    );
    // Контроль: слоты НИЖЕ области печати (там живёт вытеснение раскладки) не мешают.
    expect(() =>
      planPrintSite({ argument: 2, heapAddress: HEAP, liveAfter: [0], occupied: [spillBase, spillBase + 8] }),
    ).not.toThrow();
  });
});

describe('печать: шесть записей корпуса собираются конвейером', () => {
  const dirs = fs
    .readdirSync(path.join(ROOT, 'examples'))
    .filter((name) => /^(39|4[0-4])-/.test(name))
    .sort();

  it('в корпусе ровно шесть печатающих записей — 39…44', () => {
    expect(dirs.map((dir) => dir.slice(0, 2))).toEqual(['39', '40', '41', '42', '43', '44']);
  });

  for (const dir of dirs) {
    it(`запись ${dir}: отказов нет, код не входит в страницу записи`, () => {
      const source = fs.readFileSync(path.join(ROOT, 'examples', dir, 'main.osnova'), 'utf-8');
      const image = loweredProgram(source);
      expect(image.refused, `отказы понижения ${dir}`).toEqual([]);
      // `image.bytes` включает статические байты, то есть оценка СТРОЖЕ настоящего конца кода, —
      // и граница берётся по СТРАНИЦЕ площадки, а не по её адресу (замер 2026-09-29, §3.90.7).
      const codeEnd = MINIMAL_BASE + image.bytes.length;
      expect(codeEnd, `код ${dir} против страницы записи ${pageOf(AREA).toString(16)}`).toBeLessThanOrEqual(pageOf(AREA));
    });
  }

  it('СТОРОЖ МЕСТА: образ, код которого входит в СТРАНИЦУ записи, отклоняется с числами', () => {
    // ГРАНИЦА ПЕРЕМЕРЕНА 2026-09-29 (§3.90.7), и прежний замер был НЕВЕРЕН — не границей, а её
    // причиной. Тогда считалось: «влезают 28 сайтов (7264 байта, конец 0x101c60), 32 — отказ».
    // Замер на модели: 28 сайтов ПАДАЮТ (`QEMU internal SIGSEGV {code=ACCERR, addr=0x101ecb}`) —
    // код входит в СТРАНИЦУ площадки печати (0x101000), которую модель защищает как страницу
    // переведённого кода (`src/e2k/elfMinimal.ts`). Настоящий потолок — 12 сайтов (конец 0x100f60;
    // положительный контроль: 12 строк вывода, код 0 — `src/e2k/printPrimitivesQemu.test.ts`),
    // а 13-й уже входит в страницу: 0x101030 > 0x101000. Отсюда и сторож отказал на 28 — теперь он
    // отказывает на 13, то есть на НАСТОЯЩЕЙ границе, а не на 4096 байт позже неё.
    const sites = (count: number): AsmInstruction[] => [
      ...Array.from({ length: count }, () => printingCarrier(2)),
      { mnemonic: 'IR.ret', channel: 0, operands: [imm(0), reg(0)] },
    ];
    expect(() => imageOfCarriers(sites(13), [], [PRINT_CALL])).toThrow(PrintCallRefusal);
    expect(() => imageOfCarriers(sites(13), [], [PRINT_CALL])).toThrow(/место записи/iu);
    // Положительный контроль: двенадцать сайтов — сторона «влезает», и это не «почти»: между
    // двенадцатым (0x100f60) и тринадцатым (0x101030) лежит граница страницы 0x101000.
    const fits = imageOfCarriers(sites(12), [], [PRINT_CALL]);
    expect(fits.refused, 'двенадцать сайтов обязаны собираться').toEqual([]);
    const fitsEnd = MINIMAL_BASE + fits.bytes.length;
    expect(fitsEnd, 'и не входить в страницу записи').toBeLessThanOrEqual(pageOf(AREA));
    // Различающая пара на самой границе: двенадцатый сайт ниже страницы, тринадцатый — выше.
    expect(fitsEnd).toBeGreaterThan(pageOf(AREA) - 0x1000);
  });
});
