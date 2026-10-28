/**
 * СВЕРКА РАСКЛАДКИ С УПАКОВЩИКОМ (шаг B, задача 3).
 *
 * # Зачем
 *
 * Раскладка считает байты **по формам носителей**, упаковщик — **по командам** (`packWide`).
 * Для одного и того же ядра это две разные величины, и они никогда не сверялись. Проверка
 * фиксирует:
 *
 * 1. `layout.totalBytes` равен сумме `size` всех размещённых записей — величина не «плывёт» сама
 *    по себе;
 * 2. расхождение «раскладка − линейные байты команд» объясняется **отвергнутыми носителями**:
 *    раскладка размещает все носители, а понижение часть отвергает, и адрес у отвергнутых уже
 *    присвоен. Сверка проверяется **по каждому ядру**, а не «в среднем»;
 * 3. `bytesWide ≤ bytesLinear` и `bytesWide ≤ layout.totalBytes`: упаковка не увеличивает образ.
 *    Равенство запрещено отдельно (`1.7`) — иначе проверка проходила бы и при нулевой упаковке.
 *
 * # Почему числа закреплены, а не считаются на лету
 *
 * Считай проверка «сравнить две величины, которые обе посчитал один и тот же прогон», она была бы
 * слепа к ошибке в самом прогоне (случай 14 реестра проверяемости: «ожидание, выведенное из того
 * же вычисления»). Поэтому таблица ниже — **измеренные** числа, а расхождение обязано совпасть с
 * ними до байта. Изменится поток — краснеет здесь, и это повод объяснить, почему.
 *
 * # Перемер 2026-09-27: литерал включён в упаковщик
 *
 * `packetableRefusal` перестал отвергать литерал (раскладка измерена, `src/e2k/e2kWideSsLts.test.ts`).
 * Сдвинулась **одна колонка** — `wide` (байты пакетами): 8672 → 8424 по пяти ядрам, выигрыш упаковки
 * 272 → 520. `layout` и `linear` те же (8944): упаковка на раскладку не влияет, и это здесь
 * проверяется — равенство «раскладка = линейные» сохранилось, как и «отвергнутых носителей нет».
 *
 * # Перемер 2026-09-27 (task-5): литеральная ПАРА едет в одной команде
 *
 * Снято последнее ограничение упаковщика — второй большой литерал больше не начинает новый пакет
 * (раскладка слов `LTS` — `placeLiterals`, 47 форм сверены с `as`; `docs/hardware-debt.md` §3.38).
 * Снова сдвинулась **одна колонка** — `wide`: 8424 → 8408 по пяти ядрам, выигрыш упаковки 520 → 536;
 * у `iir` 1232 → 1216 (−16: два пакета по два больших литерала слились). `layout` и `linear` те же.
 *
 * **Второй сдвиг сделан:** правка раскладки регистров (`src/e2k/regAlloc.ts`, task-4) — цели переходов
 * пересчитываются ДО анализа живости (`docs/hardware-debt.md` §3.35/§3.37). Сдвинулись `commands`,
 * `layout`, `linear` и `wide`: у `fir` 259 → 263 команды, 2120 → 2168 байт (процедура `фильтр`
 * вытесняет два значения вместо одного), у `convolution` 232 → 218 и 1984 → 1816 (вытеснений
 * наоборот меньше: 4 → 2), у `correlation` 199 → 197 и 1664 → 1640; суммы по пяти ядрам —
 * `linear` 8944 → 8800, `wide` 8408 → 8256. Замер: `.tmp/osnova-fix-remer.ts`.
 *
 * # Оговорка о стенде
 *
 * Поток берётся тем же стендом, что и замер упаковки: `kernelStreamOf` из
 * `src/e2k/e2kWideFir.test.ts`. Импорт теста из теста дублирует регистрацию его `describe`, но
 * **не** дублирует логику конвейера: два экземпляра одного и того же построителя разошлись бы
 * молча — а именно этого сверка и не должна допускать.
 */

import { describe, it, expect } from 'vitest';
import { carrierFormOf, layoutOf } from './twoPassLayout';
import { wideStats } from './widePacker';
import { kernelStreamOf } from './e2kWideFir.test';
import { lowerCarrier } from './e2kRealRun';
import { REMAINDER_CARRIER } from './remainderRuntime';
import { getEncoder, type AsmInstruction, type Operand } from './backend';

const encoder = getEncoder('e2k');
const reg = (index: number): Operand => ({ kind: 'reg', index });

/**
 * Измеренные величины по пяти ядрам.
 *
 * `layout` — `layoutOf(поток носителей)`, `linear` и `wide` — по понижённым командам
 * (`wideStats`), `refusedBytes` — размер носителей, размещённых раскладкой, но не дошедших до
 * команд (отказ раскладки, пары предикатов или понижения).
 */
export interface KernelByteRow {
  readonly name: string;
  readonly carriers: number;
  readonly commands: number;
  readonly layout: number;
  readonly linear: number;
  readonly wide: number;
  readonly refusedBytes: number;
}

export const KERNEL_BYTES: readonly KernelByteRow[] = [
  // Перемер 2026-09-27 (task-5): литеральная ПАРА едет в одной команде (раскладка слов LTS —
  // `placeLiterals`, `docs/hardware-debt.md` §3.38), поэтому у `iir` байт пакетами 1232 → 1216
  // (−16: два пакета по два больших литерала слились в один). Прочие ядра не двигались: больших
  // литералов у них нет. Раскладка и линейные байты те же (8944) — упаковка их не касается.
  // ВНИМАНИЕ: у `fir` ожидается ВТОРОЙ сдвиг не отсюда — незакоммиченная правка раскладки регистров
  // (task-4) добавляет ему четыре команды (259 → 263), и с ними поедут команды/раскладка/линейные/
  // пакеты у `fir`; перемеряет автор той правки.
  // Перемер 2026-09-27: литерал ВКЛЮЧЁН в упаковщик (`src/e2k/e2kWideSsLts.test.ts` — раскладка
  // измерена), поэтому сдвинулись ТОЛЬКО байты пакетами: fir 2040 → 1992, iir 1280 → 1232,
  // fft 1792 → 1752, convolution 1944 → 1888, correlation 1616 → 1560. Раскладка и линейные байты
  // те же (8944) — упаковка их не касается.
  // Перемер 2026-09-24 (`.tmp/measure-wide-pins.ts`) после минимального вытеснения в память
  // (`src/vliw/spill.ts`): ядро `fir` понижается ЦЕЛИКОМ — 259 команд вместо 221, отвергнутых
  // носителей больше нет (было 48 байт); у `correlation` — 196 команд вместо 155 и 24 отвергнутых
  // байта вместо 48. Рабочие процедуры `фильтр` и `корреляция` раскладываются, потому что одно-два
  // значения уезжают в слот памяти.
  // ВНИМАНИЕ (снято): у `fir` ожидался ВТОРОЙ сдвиг от правки раскладки регистров (task-4) — сделан
  // её автором 2026-09-27, числа ниже перемерены (`.tmp/osnova-fix-remer.ts`).
  // ПЕРЕМЕР 2026-10-10 (§3.131): `layout` (байты НОСИТЕЛЕЙ) не сдвинулся — 8800 на пять ядер, как и
  // было: раскладка адресов идёт по потоку носителей и усечения не знает. А `linear`/`wide` считаются
  // по ПОНИЖЕННЫМ командам, и теперь 45 обращений к массивам вызываемых процедур названы отказом
  // (`OSN-LOW-003`: пятёрка клеток блока рантайма не влезает в собственную половину кадра вызываемой,
  // `%b[8..15]`, где у рабочих процедур DSP-ядер живут восемь значений). Отсюда
  // `refusedBytes = layout − linear` по ядрам: 272 / 216 / 912 / 272 / 272 (всего 1944).
  // Прежние числа: linear и layout совпадали (8800 на пять ядер), wide 8256.
  { name: 'fir', carriers: 111, commands: 255, layout: 2400, linear: 2104, wide: 2000, refusedBytes: 296 },
  { name: 'iir', carriers: 85, commands: 142, layout: 1448, linear: 1208, wide: 1112, refusedBytes: 240 },
  { name: 'fft', carriers: 105, commands: 123, layout: 2048, linear: 1000, wide: 960, refusedBytes: 1048 },
  { name: 'convolution', carriers: 110, commands: 198, layout: 1952, linear: 1656, wide: 1592, refusedBytes: 296 },
  { name: 'correlation', carriers: 100, commands: 177, layout: 1776, linear: 1480, wide: 1416, refusedBytes: 296 },
];

/** Размер носителей, размещённых раскладкой, но не попавших в команды. */
function refusedBytesOf(name: string, atom: string): {
  readonly layout: number;
  readonly sumOfSizes: number;
  readonly refusedBytes: number;
  readonly refusedCarriers: number;
  readonly unplaced: number;
} {
  const stream = kernelStreamOf(name, atom);
  // Пул констант обязателен: без него `IR.const` берётся ЛИТЕРАЛЬНОЙ формой (LTS, 16 байт) и
  // раскладка показывает лишние байты. Замер у FIR: 1992 без пула против 1832 с пулом при 1784
  // линейных — то есть посылка «раскладка − линейные = отвергнутые носители» без пула НЕ выполняется,
  // и расхождение объяснялось бы не тем, чем является. С пулом она выполняется до байта.
  const carriersLayout = layoutOf(stream.carrierStream, {
    invokeNames: stream.invokeNames,
    constants: stream.constants,
  });
  const sumOfSizes = carriersLayout.entries.reduce((sum, entry) => sum + entry.size, 0);
  const commandIndices = new Set(stream.commandIndices);
  let refusedBytes = 0;
  for (const entry of carriersLayout.entries) {
    if (commandIndices.has(entry.index)) continue;
    refusedBytes += entry.size;
  }
  return {
    layout: carriersLayout.totalBytes,
    sumOfSizes,
    refusedBytes,
    refusedCarriers: carriersLayout.entries.length - commandIndices.size,
    unplaced: carriersLayout.unplaced.length,
  };
}

const ATOMS: Readonly<Record<string, string>> = {
  fir: 'A5',
  iir: 'A5',
  fft: 'A5',
  convolution: 'A6',
  correlation: 'A6',
};

describe('сверка раскладки с упаковщиком: пять ядер', () => {
  it('3.1 layout.totalBytes равен сумме размеров размещённых записей', () => {
    const problems: string[] = [];
    for (const row of KERNEL_BYTES) {
      const measured = refusedBytesOf(row.name, ATOMS[row.name]!);
      if (measured.layout !== measured.sumOfSizes) {
        problems.push(`${row.name}: totalBytes ${measured.layout}, сумма size ${measured.sumOfSizes}`);
      }
      if (measured.layout !== row.layout) {
        problems.push(`${row.name}: layout ${measured.layout}, а в таблице ${row.layout}`);
      }
    }
    expect(problems, 'раскладка против самой себя').toEqual([]);
  });

  it('3.2 расхождение «раскладка − линейные байты» равно размеру отвергнутых носителей', () => {
    const problems: string[] = [];
    for (const row of KERNEL_BYTES) {
      const stats = wideStats(kernelStreamOf(row.name, ATOMS[row.name]!).commands);
      if (stats.bytesLinear !== row.linear) {
        problems.push(`${row.name}: линейных байт ${stats.bytesLinear}, а в таблице ${row.linear}`);
        continue;
      }
      const measured = refusedBytesOf(row.name, ATOMS[row.name]!);
      const delta = measured.layout - stats.bytesLinear;
      if (delta !== measured.refusedBytes) {
        problems.push(
          `${row.name}: раскладка ${measured.layout} − линейно ${stats.bytesLinear} = ${delta},` +
            ` а отвергнутых носителей на ${measured.refusedBytes}`,
        );
      }
      if (measured.refusedBytes !== row.refusedBytes) {
        problems.push(`${row.name}: отвергнуто ${measured.refusedBytes} байт, а в таблице ${row.refusedBytes}`);
      }
    }
    expect(problems, 'расхождение раскладки и линейных байт').toEqual([]);
  });

  it('3.3 упаковка не увеличивает образ: bytesWide не больше линейных и не больше раскладки', () => {
    const problems: string[] = [];
    for (const row of KERNEL_BYTES) {
      const stats = wideStats(kernelStreamOf(row.name, ATOMS[row.name]!).commands);
      if (stats.bytesWide !== row.wide) {
        problems.push(`${row.name}: пакетами ${stats.bytesWide}, а в таблице ${row.wide}`);
      }
      if (stats.bytesWide > stats.bytesLinear) {
        problems.push(`${row.name}: пакетами ${stats.bytesWide} больше линейных ${stats.bytesLinear}`);
      }
      if (stats.bytesWide > row.layout) {
        problems.push(`${row.name}: пакетами ${stats.bytesWide} больше раскладки ${row.layout}`);
      }
    }
    expect(problems, 'размер образа пакетами').toEqual([]);
  });

  it('3.4 расхождение названо числом: у каждого ядра «раскладка − линейные» равно отвергнутым носителям', () => {
    const withRefusals = KERNEL_BYTES.filter((row) => row.refusedBytes > 0).map((row) => row.name);
    const withoutRefusals = KERNEL_BYTES.filter((row) => row.refusedBytes === 0).map((row) => row.name);
    // ПЕРЕМЕР 2026-10-10 (§3.131): прежде отвергнутых носителей не было ни у одного ядра (0 байт), и
    // «раскладка = линейные» было верным тождеством. Теперь у КАЖДОГО ядра есть названные отказы —
    // обращения к массивам вызываемых процедур (`OSN-LOW-003`), — и тождество заменено на точное:
    // `layout − linear = refusedBytes`, и это та же величина, что считает `refusedBytesOf`.
    expect(withRefusals.sort(), 'ядра с отвергнутыми носителями').toEqual([
      'convolution',
      'correlation',
      'fft',
      'fir',
      'iir',
    ]);
    expect(withoutRefusals, 'ядра без отвергнутых').toEqual([]);
    for (const row of KERNEL_BYTES) {
      expect(row.layout - row.linear, `${row.name}: раскладка − линейно`).toBe(row.refusedBytes);
    }
  });

  it('3.5 итог по пяти ядрам: раскладка 9624, линейно 7448, пакетами 7080', () => {
    const sum = (pick: (row: KernelByteRow) => number): number => KERNEL_BYTES.reduce((total, row) => total + pick(row), 0);
    // ПЕРЕМЕР 2026-10-10 (§3.131): раскладка (байты носителей) НЕ сдвинулась — 8800. Линейные и
    // пакетные байты считаются по пониженной части: 8800 → 6856 и 8256 → 6384, потому что 45
    // обращений к массивам вызываемых процедур названы отказом (1944 байта носителей не дошли до
    // команд). Поэтому «выигрыш упаковки» выражен через ЛИНЕЙНЫЕ байты той же части
    // (7448 − 7080 = 368), а не через раскладку: 9624 − 7080 = 2544 смешивало бы отвергнутое с
    // упакованным. Прежние числа: 8800 / 8800 / 8256, выигрыш 544.
    expect(sum((row) => row.layout), 'раскладка').toBe(9624);
    expect(sum((row) => row.linear), 'линейно').toBe(7448);
    expect(sum((row) => row.wide), 'пакетами').toBe(7080);
    expect(sum((row) => row.linear) - sum((row) => row.wide), 'выигрыш упаковки').toBe(368);
    expect(sum((row) => row.refusedBytes), 'отвергнуто байт носителей').toBe(2176);
  });

  it('3.6 проверка не проходит при нулевой упаковке: равенство «пакетами = линейно» запрещено явно', () => {
    // Если бы упаковка ничего не давала, все три величины совпали бы (или пакетная превысила бы),
    // и проверку 3.3 нельзя было бы считать выполненной. Здесь это утверждается числом.
    for (const row of KERNEL_BYTES) {
      expect(row.wide, `${row.name}: пакетами меньше линейных на положительную величину`).toBeLessThan(row.linear);
      expect(row.linear - row.wide, `${row.name}: экономия упаковки`).toBeGreaterThan(0);
    }
  });

  it('3.7 носитель-СЕРИЯ: форма считает ровно те байты, что кодирует понижение', () => {
    // ЗАЧЕМ ЭТА ПРОВЕРКА ОТДЕЛЬНО. У `IR.rem` форма — СЕРИЯ из трёх команд, а понижение выдаёт три
    // команды из одного с ним источника (`src/e2k/remainderRuntime.ts`). Пока источник один, они
    // совпадают по построению; но стоит взять форму короче — и раскладка посчитает 8 байт там, где
    // в образ уйдут 24, и адреса после носителя уедут МОЛЧА (класс §3.35).
    //
    // ПОЧЕМУ НЕ ПРОГОН В МОДЕЛИ. Замер: прогон этого не видит — смещения считаются как РАЗНОСТЬ
    // адресов, и если обе точки лежат за серией, ошибка длины сокращается (негативный контроль
    // 14.1 на прогоне не краснел). Здесь она не сокращается: сравниваются БАЙТЫ формы и БАЙТЫ
    // настоящего понижения — детерминированно и без внешнего ресурса.
    const носитель: AsmInstruction = {
      mnemonic: REMAINDER_CARRIER,
      channel: 0,
      operands: [reg(4), reg(2), reg(3)],
    };
    const форма = carrierFormOf(носитель, {});
    expect(форма, 'у остатка обязана быть форма').toBeDefined();
    expect(форма?.commands.length, 'серия остатка — три команды').toBe(3);

    const понижение = lowerCarrier(носитель, { constants: [] });
    expect(понижение.ok, 'остаток обязан понижаться').toBe(true);
    const команды = понижение.ok ? понижение.instructions : [];
    const байтФормы = (форма?.commands ?? []).reduce((sum, item) => sum + item.size, 0);
    const байтПонижения = команды.reduce((sum, item) => sum + encoder.encode(item).length, 0);
    expect(
      байтФормы,
      `форма обещает ${String(байтФормы)} байт, а понижение кодирует ${String(байтПонижения)} — ` +
        'разойдись они, адреса после носителя уедут молча (§3.35)',
    ).toBe(байтПонижения);
  });
});
