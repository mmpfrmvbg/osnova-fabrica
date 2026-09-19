/**
 * ОРАКУЛ РАЗМЕРА ШИРОКОЙ КОМАНДЫ (шаг B, задача 1).
 *
 * # Зачем отдельный оракул
 *
 * Раскладка (`src/e2k/twoPassLayout.ts`) считает размер инструкции как сумму размеров её команд:
 * `sizeOfCarrier` собирает `form.commands.reduce((sum, command) => sum + command.size, 0)`
 * (`twoPassLayout.ts:405-409`), а `layoutOf` тем же способом считает размер записи (`:520`).
 * Для **одиночной** команды это верно. Для **широкой** — нет: у неё одной нет ни в одной строке
 * `CARRIER_FORMS`, потому что она собирается из нескольких команд, а её длину задаёт не сумма
 * слогов, а структура команды: HS + слоги ALS по 4 байта + полуслоги ALES по 2 байта, по два на
 * слово, с добивкой до чётного числа слов (`src/e2k/widePacker.ts:110-144`).
 *
 * # Формула, и почему она НЕ «N × 8»
 *
 * Первая редакция задания называла размер пакета как «N × 8 байт» (N — число слогов). Это
 * **расходится с кодировщиком**: при N = 3 вышло бы 24 байта, а `packWide` даёт **16**
 * (`src/e2k/widePackets.test.ts:73-74`: «HS + 3 ALS = 4 слова = 16 байт»), при N = 5 — 40 против
 * **24**. Проверено прогоном реального кодировщика (`.tmp/brainstorm-packet-size.ts`).
 *
 * Верная формула:
 *
 * ```
 * слова = добивка_до_чётного(1 + N + ceil(ALES / 2))
 * байт  = слова × 4
 * ```
 *
 * где `1` — заголовочный слог HS, `N` — число слогов ALS, `ALES` — число слогов с полуслогом
 * (длинная форма: `muls` — ALF11), по два полуслога на слово (`widePacker.ts:123-127`).
 *
 * Источники размеров — **не пересказ формулы**, а существующие оракулы и код:
 * `docs/e2k-wide-commands.md` §2.2, §2.5 (`gas/config/tc-e2k.c:9488-9492`), `widePacker.ts:129`,
 * `src/e2k/widePackets.test.ts:63-64,73-74,88-89`.
 *
 * # Красный до реализации — это и требуется
 *
 * `sizeOfWideGroup` в проекте **нет**: тест ниже импортирует его напрямую и потому падает на
 * импорте. Так и задумано: оракул пишется **до** реализации. Импорт намеренно статический: если бы
 * проверка была «мягкой», красный прогон доказывал бы только то, что функции нет, а не то, что
 * оракул чувствителен к дефектам — последнее покажет негативный контроль (задача 4).
 */

import { describe, it, expect } from 'vitest';
import { packWide, MAX_SLOTS } from './widePacker';
import { firstPass, layoutOf, sizeOfCarrier, sizeOfWideGroup } from './twoPassLayout';
import type { AsmInstruction, Operand } from './backend';

const reg = (index: number): Operand => ({ kind: 'reg', index });
/** `adds` — короткая форма ALF1: слог ALS без полуслога. */
const add = (src1: number, src2: number, dst: number): AsmInstruction => ({
  mnemonic: 'adds',
  channel: 0,
  operands: [reg(src1), reg(src2), reg(dst)],
});
/** `muls` — длинная форма ALF11: слог ALS **и** полуслог ALES. */
const mul = (src1: number, src2: number, dst: number): AsmInstruction => ({
  mnemonic: 'muls',
  channel: 0,
  operands: [reg(src1), reg(src2), reg(dst)],
});

/** Измеренный образец: слогов всего, из них длинных (ALES), и байт у **одной** широкой команды. */
export interface MeasuredGroup {
  readonly slots: number;
  readonly ales: number;
  readonly bytes: number;
}

/**
 * Собрать из инструкций **одну** широкую команду и измерить её кодировщиком.
 *
 * @throws если слоги не уложились в одну команду: каналы заняты (две операции в один канал — отказ
 *   ассемблера, `docs/e2k-wide-commands.md` §2.6), и тогда сумма байт описывала бы не широкую
 *   команду, а несколько. Молча суммировать их нельзя — это была бы подмена предмета замера.
 */
export function measureOneGroup(instructions: readonly AsmInstruction[]): MeasuredGroup {
  const packets = packWide(instructions);
  if (packets.length !== 1) {
    throw new Error(
      `ожидалась одна широкая команда, получилось ${packets.length}: ` +
        packets.map((packet) => packet.slots.map((slot) => slot.channel).join('+')).join(' | '),
    );
  }
  const packet = packets[0]!;
  const ales = packet.slots.filter((slot) => slot.instruction.mnemonic === 'muls').length;
  return { slots: packet.slots.length, ales, bytes: packet.bytes.length };
}

/**
 * КОНТРОЛЬНЫЕ ТОЧКИ формулы. Числа байт измеряет сам кодировщик, а не формула: формула обязана
 * совпасть с кодировщиком, а не наоборот. Где число уже утверждает существующий оракул упаковщика —
 * источник назван.
 */
export const PACKET_SIZE_SAMPLES: readonly (MeasuredGroup & { readonly source: string })[] = [
  { ...measureOneGroup([add(1, 2, 3)]), source: 'короткая форма: HS + ALS = 2 слова = 8 байт' },
  {
    ...measureOneGroup([add(1, 2, 3), add(4, 5, 6)]),
    source: 'src/e2k/widePackets.test.ts:63-64 — «HS + два ALS = 3 слова, добивка до 4 → 16 байт»',
  },
  {
    ...measureOneGroup([add(1, 2, 3), add(4, 5, 6), add(7, 8, 9)]),
    source: 'src/e2k/widePackets.test.ts:73-74 — «HS + 3 ALS = 4 слова = 16 байт»',
  },
  {
    ...measureOneGroup([add(1, 2, 3), add(4, 5, 6), add(7, 8, 9), add(10, 11, 12)]),
    source: 'HS + 4 ALS = 5 слов, добивка до 6 → 24 байта',
  },
  {
    ...measureOneGroup([add(1, 2, 3), add(4, 5, 6), add(7, 8, 9), add(10, 11, 12), add(13, 14, 15)]),
    source: 'HS + 5 ALS = 6 слов → 24 байта',
  },
  {
    ...measureOneGroup([0, 1, 2, 3, 4, 5].map((index) => add(index + 1, index + 7, index + 13))),
    source: 'HS + 6 ALS = 7 слов, добивка до 8 → 32 байта: предел поля lng (3 бита, 8 слов)',
  },
  { ...measureOneGroup([mul(1, 2, 3)]), source: 'длинная форма в одиночку: HS + ALS + ALES = 4 слова = 16 байт' },
  {
    ...measureOneGroup([mul(1, 2, 3), add(4, 5, 6)]),
    source: 'src/e2k/widePackets.test.ts:88-89 — «HS + ALS0 + ALS1 + слово ALES = 4 слова = 16 байт»',
  },
  {
    ...measureOneGroup([mul(1, 2, 3), add(4, 5, 6), add(7, 8, 9)]),
    source: 'HS + 3 ALS + ALES = 5 слов, добивка до 6 → 24 байта',
  },
];

describe('размер широкой команды: формула совпадает с кодировщиком', () => {
  it('1.1 формула даёт ровно столько байт, сколько кодирует packWide (короткие формы)', () => {
    const mismatches: string[] = [];
    for (let slots = 1; slots <= MAX_SLOTS; slots++) {
      const group = measureOneGroup(
        Array.from({ length: slots }, (_, index) => add(index + 1, index + 7, index + 13)),
      );
      const formula = sizeOfWideGroup(group.slots, group.ales);
      if (formula !== group.bytes) {
        mismatches.push(`${group.slots} слогов: формула ${formula}, кодировщик ${group.bytes}`);
      }
    }
    expect(mismatches, 'расхождение формулы с кодировщиком').toEqual([]);
  });

  it('1.2 формула даёт ровно столько байт, сколько кодирует packWide (длинные формы)', () => {
    const mismatches: string[] = [];
    for (const group of PACKET_SIZE_SAMPLES) {
      if (group.ales === 0) continue;
      const formula = sizeOfWideGroup(group.slots, group.ales);
      if (formula !== group.bytes) {
        mismatches.push(`${group.slots} слогов (${group.ales} длинных): формула ${formula}, кодировщик ${group.bytes}`);
      }
    }
    expect(mismatches, 'расхождение формулы с кодировщиком на длинных формах').toEqual([]);
  });

  it('1.3 каждое измерение образца совпадает с формулой', () => {
    const problems = PACKET_SIZE_SAMPLES.filter(
      (sample) => sizeOfWideGroup(sample.slots, sample.ales) !== sample.bytes,
    ).map(
      (sample) =>
        `${sample.slots} слогов / ${sample.ales} длинных: формула ${sizeOfWideGroup(sample.slots, sample.ales)},` +
        ` измерено ${sample.bytes} (${sample.source})`,
    );
    expect(problems, 'образцы размера').toEqual([]);
  });

  it('1.4 формула НЕ равна «N × 8» — иначе оракул закрепил бы неверное правило', () => {
    // Прямая проверка расхождения с первой редакцией задания: при «N × 8» размер пакета из трёх
    // слогов был бы 24 вместо измеренных 16.
    expect(sizeOfWideGroup(3, 0), 'три слога').toBe(16);
    expect(sizeOfWideGroup(3, 0), 'три слога не равны 3 × 8').not.toBe(24);
    expect(sizeOfWideGroup(5, 0), 'пять слогов').toBe(24);
    expect(sizeOfWideGroup(5, 0), 'пять слогов не равны 5 × 8').not.toBe(40);
  });

  it('1.5 размер кратен 4 и не превышает предел поля lng (8 слов = 32 байта)', () => {
    const bad: string[] = [];
    // Комбинации сверх предела обязаны быть **отказом**, а не числом: 6 слогов с двумя и более
    // длинными формами дают 10 слов = 40 байт, и такая команда невыразима вовсе.
    let refusals = 0;
    for (let slots = 1; slots <= MAX_SLOTS; slots++) {
      for (let ales = 0; ales <= slots; ales++) {
        let size: number;
        try {
          size = sizeOfWideGroup(slots, ales);
        } catch {
          refusals++;
          continue;
        }
        if (size % 4 !== 0) bad.push(`${slots}/${ales}: ${size} не кратно 4`);
        if (size > 32) bad.push(`${slots}/${ales}: ${size} больше 32 байт`);
      }
    }
    expect(bad, 'размеры вне диапазона').toEqual([]);
    // Отказы быть обязаны: если бы их не было вовсе, проверка выше ничего не проверяла бы.
    expect(refusals, 'отказов на формах сверх предела').toBeGreaterThan(0);
  });

  it('1.5-б форма сверх предела — названный отказ, а не размер', () => {
    // Шесть слогов, два длинных: HS + 6 ALS + 1 слово ALES = 8 слов... и ещё одно слово добивки
    // не нужно; но при трёх длинных уже 10 слов = 40 байт — предела нет.
    expect(sizeOfWideGroup(6, 0), 'шесть коротких').toBe(32);
    expect(sizeOfWideGroup(6, 1), 'шесть слогов, один длинный').toBe(32);
    expect(() => sizeOfWideGroup(5, 5), 'пять длинных').toThrow(/предел поля lng/);
    expect(() => sizeOfWideGroup(6, 3), 'шесть слогов, три длинных').toThrow(/предел поля lng/);
  });

  it('1.6 одиночный слог: короткая форма 8, длинная 16 — как в CARRIER_FORMS', () => {
    expect(sizeOfWideGroup(1, 0), 'один короткий слог').toBe(8);
    expect(sizeOfWideGroup(1, 1), 'один длинный слог').toBe(16);
  });

  it('1.7 вход проверяется: длинных слогов не может быть больше, чем слогов', () => {
    expect(() => sizeOfWideGroup(2, 3), 'ALES больше слогов').toThrow();
    expect(() => sizeOfWideGroup(0, 0), 'ноль слогов').toThrow();
  });

  it('1.8 негативный контроль: подмена размера ловится', () => {
    // «Выдуманное» правило N × 8 обязано расходиться с образцами — если бы оно совпало всюду,
    // оракул не отличал бы верную формулу от неверной.
    const wrong = (slots: number): number => slots * 8;
    const agreements = PACKET_SIZE_SAMPLES.filter((sample) => wrong(sample.slots) === sample.bytes);
    expect(agreements.length, 'совпадений «N × 8» с измерениями').toBeLessThan(PACKET_SIZE_SAMPLES.length);
    // И конкретно: расхождение обязано быть на трёх слогах, где 24 против 16.
    expect(wrong(3), '«N × 8» для трёх слогов').not.toBe(sizeOfWideGroup(3, 0));
  });
});

/**
 * РАСКЛАДКА ПОТОКА С ШИРОКОЙ КОМАНДОЙ (шаг B, задача 2).
 *
 * `layoutOf` берёт размер из формы носителя. У широкой команды формы нет — есть структура, и её
 * размер даёт `sizeOfWideGroup`. Здесь проверяется, что раскладка этим пользуется: адреса не
 * съезжают, `totalBytes` равен сумме размеров записей, а поток из одних одиночных команд считает
 * ровно как раньше (обратная совместимость).
 */
describe('раскладка: широкая команда получает размер по структуре', () => {
  /** Инструкция-контейнер: несёт только форму широкой команды. */
  const wide = (slots: number, ales: number): AsmInstruction => ({
    mnemonic: 'wide',
    channel: 0,
    operands: [],
    wideGroup: { slots, ales },
  });
  /**
   * Носитель `IR.add` — то, что раскладка умеет размещать (форма ALF1, 8 байт).
   *
   * Внимание: `layoutOf` размещает поток **носителей**, поэтому команда `adds` в нём не размещается
   * вовсе (`unplacedReason`: «не носитель IR»). Фикстуры потока обязаны быть носителями, иначе
   * проверка адресов мерила бы отказы, а не раскладку.
   */
  const carrierAdd = (): AsmInstruction => ({ mnemonic: 'IR.add', channel: 0, operands: [reg(1), reg(2), reg(3)] });

  it('2.1 запись широкой команды получает размер N по структуре, а не 0', () => {
    const layout = layoutOf([wide(3, 0)]);
    expect(layout.unplaced.length, 'неразмещённых').toBe(0);
    expect(layout.entries.length, 'записей').toBe(1);
    expect(layout.entries[0]!.size, 'размер записи').toBe(sizeOfWideGroup(3, 0));
    expect(layout.entries[0]!.size, 'три слога').toBe(16);
    // Список команд пуст осознанно: форма лежит в wideGroup, а не в commands.
    expect(layout.entries[0]!.commands.length, 'команд таблицы форм').toBe(0);
    expect(layout.entries[0]!.wideGroup, 'форма команды').toEqual({ slots: 3, ales: 0 });
  });

  it('2.2 адреса считаются с учётом размера широкой команды', () => {
    // Носитель 8 байт, затем широкая команда из трёх слогов (16), затем ещё носитель (8).
    const layout = layoutOf([carrierAdd(), wide(3, 0), carrierAdd()]);
    expect(layout.unplaced.length, 'неразмещённых').toBe(0);
    expect(layout.entries.map((entry) => entry.address), 'адреса').toEqual([0, 8, 24]);
    expect(layout.totalBytes, 'всего байт').toBe(32);
  });

  it('2.3 totalBytes равен сумме размеров записей, и разложение на команды не врёт', () => {
    const layout = layoutOf([wide(2, 1), carrierAdd(), wide(6, 0)]);
    const sum = layout.entries.reduce((total, entry) => total + entry.size, 0);
    expect(layout.totalBytes, 'totalBytes против суммы size').toBe(sum);
    // Разложение по командам: у широких записей список пуст, у носителя — одна команда 8 байт.
    const commandBytes = layout.entries.reduce(
      (total, entry) => total + entry.commands.reduce((part, command) => part + command.size, 0),
      0,
    );
    expect(commandBytes, 'байт по командам таблицы форм').toBe(8);
    expect(layout.totalBytes - commandBytes, 'байт, пришедших от широких команд').toBe(
      sizeOfWideGroup(2, 1) + sizeOfWideGroup(6, 0),
    );
  });

  it('2.4 обратная совместимость: поток без широких команд считается как раньше', () => {
    const carriers = ['IR.add', 'IR.move', 'IR.const', 'IR.mul'];
    const layout = layoutOf(carriers.map((carrier) => ({ mnemonic: carrier, channel: 0, operands: [] })));
    const expected = carriers.reduce((sum, carrier) => sum + (sizeOfCarrier(carrier) ?? 0), 0);
    expect(layout.unplaced.length, 'неразмещённых').toBe(0);
    expect(layout.totalBytes, 'сумма форм носителей').toBe(expected);
    expect(layout.entries.every((entry) => entry.wideGroup === undefined), 'ни одной широкой команды').toBe(true);
  });

  it('2.5 форма сверх предела — отказ раскладки, а не размер', () => {
    // Шесть слогов и три длинных: 10 слов = 40 байт, команда невыразима. Раскладка обязана
    // отказать названно, а не посчитать адреса по несуществующей длине.
    expect(() => layoutOf([wide(6, 3)]), 'форма сверх предела').toThrow(/предел поля lng/);
  });

  it('2.6 firstPass пользуется тем же размером, что layoutOf', () => {
    const stream = [carrierAdd(), wide(4, 0), carrierAdd()];
    const addresses = firstPass(stream);
    expect([...addresses.entries()], 'адреса первого прохода').toEqual([
      [0, 0],
      [1, 8],
      [2, 32],
    ]);
  });
});
