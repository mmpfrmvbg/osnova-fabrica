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
  { name: 'fir', carriers: 111, commands: 235, layout: 2064, linear: 2064, wide: 2048, refusedBytes: 0 },
  { name: 'iir', carriers: 91, commands: 145, layout: 1312, linear: 1312, wide: 1296, refusedBytes: 0 },
  { name: 'fft', carriers: 105, commands: 204, layout: 1760, linear: 1760, wide: 1744, refusedBytes: 0 },
  { name: 'convolution', carriers: 110, commands: 160, layout: 1472, linear: 1424, wide: 1392, refusedBytes: 48 },
  { name: 'correlation', carriers: 100, commands: 176, layout: 1544, linear: 1544, wide: 1536, refusedBytes: 0 },
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
  const carriersLayout = layoutOf(stream.carrierStream, { invokeNames: stream.invokeNames });
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
    expect(withRefusals, 'ядра с отвергнутыми носителями').toEqual(['convolution']);
    expect(withoutRefusals.length, 'ядер без отвергнутых').toBe(4);
    for (const row of KERNEL_BYTES) {
      if (row.refusedBytes !== 0) continue;
      expect(row.layout - row.linear, `${row.name}: раскладка против линейных`).toBe(0);
    }
    // И у единственного ядра с отказами расхождение названо точно.
    const convolution = KERNEL_BYTES.find((row) => row.name === 'convolution')!;
    expect(convolution.layout - convolution.linear, 'convolution: раскладка − линейно').toBe(48);
    expect(convolution.refusedBytes, 'convolution: отвергнутые носители').toBe(48);
  });

  it('3.5 итог по пяти ядрам: раскладка 8152, линейно 8104, пакетами 8016', () => {
    const sum = (pick: (row: KernelByteRow) => number): number => KERNEL_BYTES.reduce((total, row) => total + pick(row), 0);
    expect(sum((row) => row.layout), 'раскладка').toBe(8152);
    expect(sum((row) => row.linear), 'линейно').toBe(8104);
    expect(sum((row) => row.wide), 'пакетами').toBe(8016);
    expect(sum((row) => row.layout) - sum((row) => row.wide), 'выигрыш упаковки').toBe(136);
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
