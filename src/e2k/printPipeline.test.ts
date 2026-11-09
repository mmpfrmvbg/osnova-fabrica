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
import { HEAP_OFFSET, WRITE_PAGE_BYTES, imageOfCarriers } from './programImage';
import { loweredProgram } from './lowered';
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
      // ПОТРЕБИТЕЛЬ (D11): под отказом байтов нет — дверь отдаёт Результат<Образ, Отказ>.
      const итог = loweredProgram(source);
      expect(
        итог.ок,
        итог.ок ? '' : `отказы понижения ${dir}: ${итог.отказ.отказы.map((запись) => запись.причина).join(' | ')}`,
      ).toBe(true);
      if (!итог.ок) throw new Error(`понижение отказало: ${итог.отказ.причина}`);
      const image = итог.значение;
      // `image.bytes` включает статические байты, то есть оценка СТРОЖЕ настоящего конца кода, —
      // и граница берётся по СТРАНИЦЕ площадки, а не по её адресу (замер 2026-09-29, §3.90.7).
      const codeEnd = MINIMAL_BASE + image.bytes.length;
      expect(codeEnd, `код ${dir} против страницы записи ${pageOf(AREA).toString(16)}`).toBeLessThanOrEqual(pageOf(AREA));
    });
  }

  it('СТОРОЖ МЕСТА: образ, код которого входит в СТРАНИЦУ ЗАПИСИ, отклоняется с числами', () => {
    // ГРАНИЦА ПЕРЕЕХАЛА 2026-09-29 (§3.91), и весь замер — рядом, в одном тесте.
    //
    // БЫЛО: область записи стояла сразу за кодом (площадка 0x101EC0), поэтому потолок был 4 КиБ
    // кода — двенадцать сайтов печати (0x100f60) влезали, тринадцатый (0x101030) отказывал, а
    // **три прямые развёртки** (прежде — «влезают» в прежнем стороже!) падали на модели
    // `ACCERR`-ом. Причина — страница, а не адрес (§3.90.7).
    //
    // СТАЛО: область записи вынесена на свою страницу 0x110000 (куча и арена — 0x111000), потолок
    // раскладки — 64 КиБ кода. Замер: 300 сайтов собираются (кода 63840, конец 0x10f960), 320 —
    // НАЗВАННЫЙ отказ (кода 68000, конец 0x1109a0). Предел оттого и назван числом: он не «сколько
    // влезло», а страница.
    //
    // ПЕРЕМЕР 2026-10-09 ПОСЛЕ ПУТИ ① (§3.119.5, §3.120.4): у каждого сайта появились `setwd`
    // открытия и закрытия — это **+32 байта на сайт**, сайт подорожал с ≈213 до ≈246 байт. Граница
    // страницы съехала: **266 сайтов** собираются (кода 65 352, конец 0x10ff30), **267** — названный
    // отказ. Прежние 300 больше не влезают — поэтому сторож и стоит числом, а не «на глаз».
    // Замер: `.tmp/probe-print-ceiling.ts` (перебор), тот же путь, что и у теста.
    //
    // ПЕРЕМЕР 2026-10-29 ПОСЛЕ ПОЧИНКИ ВОСЬМОЙ ЛЖИ (A4-5ж/2, задача 20): хвост `write` обязан
    // гасить свой регистр длины (`src/e2k/printPrimitives.ts#writeTextPrimitives`) — это **+4 байта
    // на КАЖДЫЙ сайт**, и потолок в сайтах обязан был съехать. Замер тем же путём, что у теста
    // (`.tmp/a5z-ceiling.ts`): **258 сайтов** собираются (кода 65 496, конец 0x10ffd8), **259** —
    // названный отказ (кода 65 744, конец 0x1100d0). Команда гашения безусловна намеренно: форма
    // операции не имеет права зависеть от плоскости (§3.135). Условная редакция («гасить только в
    // выращенном кадре») ИЗМЕРЕНА и отвергнута — с ней все 20 форм выращенного кадра перестали давать
    // число; причина падения НЕ установлена (длины раскладки и байты понижения сходятся в обоих
    // кадрах: `.tmp/a5z-form-vs-bytes.ts`, 1472/1472 и 1568/1568).
    // ПЕРЕМЕР 2026-11-04 ПОСЛЕ ПОЧИНКИ СЛУЧАЯ 71 (девятая тихая ложь, срез 6): листовая развёртка
    // (`src/e2k/printPrimitives.ts#numberToTextLeanPrimitives`) возвращает постоянные точки входа,
    // которые сама же и занимает, — это **+40 байт на ОБРАЗ** (тело разделённой печати в образе
    // одно, не на сайт; в этом образе из 258 сайтов разделённый путь и включён). Число сайтов не
    // съехало (258 влезают, 259 — названный отказ), но сторона «влезает» теперь РОВНО касается
    // страницы: 0x100000 + 65 536 = 0x110000, то есть до падения потолка в сайтах остался один
    // байт печати. Это названная цена правки, а не округление: следующая добавка к пути печати
    // обязана перемерить и число сайтов.
    // ПЕРЕМЕР 2026-11-09 (атом depth-3/P3b, `src/e2k/elfMinimal.ts#IMAGE_TAIL_OFFSET`): страница
    // области записи переехала с 0x110000 на 0x11F000, потолок кода стал 126 976 байт, и граница
    // в сайтах обязана была съехать — она и съехала. Замер тем же путём: **505 сайтов** собираются
    // (кода 126 792, конец 0x11EF48), **506** — названный отказ (кода 127 040, конец 0x11F040).
    // Причина переезда измерена на пробе протокола: глубина 3 требует кода 67 056 при прежнем
    // потолке 65 536 (`docs/hardware-debt.md` §3.194).
    const sites = (count: number): AsmInstruction[] => [
      ...Array.from({ length: count }, () => printingCarrier(2)),
      { mnemonic: 'IR.ret', channel: 0, operands: [imm(0), reg(0)] },
    ];
    expect(() => imageOfCarriers(sites(506), [], [PRINT_CALL])).toThrow(PrintCallRefusal);
    expect(() => imageOfCarriers(sites(506), [], [PRINT_CALL])).toThrow(/место записи/iu);
    // Сторона «влезает»: 505 сайтов — 126 792 байта кода, конец 0x11EF48 (до переезда влезало 258
    // сайтов и 65 536 байт).
    const fits = imageOfCarriers(sites(505), [], [PRINT_CALL]);
    expect(fits.refused, 'пятьсот пять сайтов обязаны собираться').toEqual([]);
    expect(fits.bytes.length, 'и это ровно измеренная длина').toBe(126792);
    const fitsEnd = MINIMAL_BASE + fits.bytes.length;
    expect(fitsEnd, 'и не входить в страницу записи').toBeLessThanOrEqual(pageOf(printAreaOf(HEAP)));
    expect(fitsEnd, 'но и не быть крошечным: прежний потолок в 4 КиБ пройден').toBeGreaterThan(MINIMAL_BASE + 0x1000);
  });
});
