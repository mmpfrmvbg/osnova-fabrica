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
import { layoutOf } from './twoPassLayout';
import { wideStats } from './widePacker';
import { kernelStreamOf } from './e2kWideFir.test';

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
  { name: 'fir', carriers: 111, commands: 263, layout: 2168, linear: 2168, wide: 2048, refusedBytes: 0 },
  // У `iir` команды 158 (было 161), носителей 85 (было 91): трюк `(a - a % b) / b` заменён оператором
  // `div` (2026-09-25) — из потока ушли вызов `система.математика.остаток` и вычитание, пришёл `sdivs`.
  { name: 'iir', carriers: 85, commands: 158, layout: 1336, linear: 1336, wide: 1208, refusedBytes: 0 },
  { name: 'fft', carriers: 105, commands: 228, layout: 1840, linear: 1840, wide: 1744, refusedBytes: 0 },
  { name: 'convolution', carriers: 110, commands: 218, layout: 1816, linear: 1816, wide: 1712, refusedBytes: 0 },
  // У `correlation` отвергнутых носителей больше нет (199 команд, было 196): правка сопоставления пар
  // (`src/e2k/predicatePairing.ts` — носители вытеснения перестали быть «неизвестными», а у вызова
  // считается только существующий аргумент) сняла ложный отказ сравнения.
  { name: 'correlation', carriers: 100, commands: 197, layout: 1640, linear: 1640, wide: 1544, refusedBytes: 0 },
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

  it('3.4 расхождение объяснено: у ядер без отвергнутых носителей раскладка и линейные совпадают', () => {
    const withRefusals = KERNEL_BYTES.filter((row) => row.refusedBytes > 0).map((row) => row.name);
    const withoutRefusals = KERNEL_BYTES.filter((row) => row.refusedBytes === 0).map((row) => row.name);
    // Перемер 2026-09-24 после подъёма предела вытеснения до 4: отвергнутых носителей не осталось
    // НИ У ОДНОГО ядра — свёртка тоже раскладывается (четыре значения в слот), и её `IR.invoke` с
    // `IR.call` понижены. Было: свёртка 48 байт, до вытеснения — три ядра по 48 байт.
    expect(withRefusals, 'ядра с отвергнутыми носителями').toEqual([]);
    expect(withoutRefusals.length, 'ядер без отвергнутых').toBe(5);
    for (const row of KERNEL_BYTES) {
      if (row.refusedBytes !== 0) continue;
      expect(row.layout - row.linear, `${row.name}: раскладка против линейных`).toBe(0);
    }
    // И у ядер с отказами расхождение названо точно: раскладка минус линейные равно отвергнутым.
    for (const row of KERNEL_BYTES) {
      if (row.refusedBytes === 0) continue;
      expect(row.layout - row.linear, `${row.name}: раскладка − линейно`).toBe(row.refusedBytes);
    }
  });

  it('3.5 итог по пяти ядрам: раскладка 8800, линейно 8800, пакетами 8256', () => {
    const sum = (pick: (row: KernelByteRow) => number): number => KERNEL_BYTES.reduce((total, row) => total + pick(row), 0);
    // Перемер 2026-09-27 (task-4, `docs/hardware-debt.md` §3.37): раскладка регистров исправлена —
    // раскладка и линейные 8944 → 8800, пакетами 8408 → 8256, выигрыш упаковки 536 → 544.
    // По ядрам: `fir` +48 байт (процедура `фильтр` вытесняет два значения вместо одного),
    // `convolution` −168 и `correlation` −24 (вытеснений наоборот меньше). Раскладка и линейные
    // по-прежнему совпадают: отвергнутых носителей нет ни у одного ядра. Замер: `.tmp/osnova-fix-remer.ts`.
    // Прежде: перемер 2026-09-27 (task-5, литеральная ПАРА) — пакетами 8424 → 8408 (у `iir`
    // 1232 → 1216), выигрыш 520 → 536; перемер 2026-09-27 (литерал включён в упаковщик) — пакетами
    // 8424 (было 8672), выигрыш 520 (было 272); перемер 2026-09-25 после замены трюка на `div`:
    // 8944 / 8944 / 8672, выигрыш 272.
    expect(sum((row) => row.layout), 'раскладка').toBe(8800);
    expect(sum((row) => row.linear), 'линейно').toBe(8800);
    expect(sum((row) => row.wide), 'пакетами').toBe(8256);
    expect(sum((row) => row.layout) - sum((row) => row.wide), 'выигрыш упаковки').toBe(544);
  });

  it('3.6 проверка не проходит при нулевой упаковке: равенство «пакетами = линейно» запрещено явно', () => {
    // Если бы упаковка ничего не давала, все три величины совпали бы (или пакетная превысила бы),
    // и проверку 3.3 нельзя было бы считать выполненной. Здесь это утверждается числом.
    for (const row of KERNEL_BYTES) {
      expect(row.wide, `${row.name}: пакетами меньше линейных на положительную величину`).toBeLessThan(row.linear);
      expect(row.linear - row.wide, `${row.name}: экономия упаковки`).toBeGreaterThan(0);
    }
  });
});
