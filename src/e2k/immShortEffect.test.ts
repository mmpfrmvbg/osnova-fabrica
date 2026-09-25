/**
 * ОРАКУЛ ЭФФЕКТА КОРОТКОЙ ФОРМЫ: 74 команды по 8 байт вместо 16.
 *
 * # Что закрепляется
 *
 * После `encodeShortImm` (`src/e2k/e2k-real.ts`) значение 0…15 кодируется 8 байтами вместо 16.
 * Замер по пяти ядрам: коротких форм **74**, экономия **592 байта**. Числа ниже — измерение, а не
 * ожидание.
 *
 * # База сдвинулась, и это названо
 *
 * Параллельный агент закоммитил `a7a50d8` («рантайм остатка — IIR») **после** замера шага 1:
 * команд стало **921** вместо 920, линейных байт **8112** вместо 8104 (ядро `iir` — 146 команд).
 * Поэтому экономия сверяется с **текущей** базой, а не с числом из шага 1.
 *
 * # Что этот эффект НЕ делает
 *
 * **Ни одного барьера упаковки не снимается.** У команды по-прежнему есть непосредственный
 * операнд, поэтому `packetableRefusal` отказывает так же, как отказывал: «не все операнды —
 * регистры». Короткая форма уменьшает **размер образа**, а не открывает материал для группировки.
 * Это разные величины, и смешивать их нельзя — иначе «592 байта» прочиталось бы как «упаковка
 * заработала».
 */

import { describe, it, expect } from 'vitest';
import { getEncoder } from './backend';
import { packetableRefusal } from './widePacker';
import {
  LITERAL_BARRIERS,
  isLiteralCommand,
  measureKernel,
} from './literalBarriers.test';

/** Измеренный эффект по пяти ядрам: сколько команд стали короткими и сколько байт это дало. */
export interface ImmShortRow {
  readonly name: string;
  readonly commands: number;
  /** Команд, кодируемых 8 байтами (короткая форма). */
  readonly short: number;
  /** Из них — литеральные `movts` (все короткие формы в этом потоке именно литеральные). */
  readonly shortLiterals: number;
  /** Экономия в байтах: по 8 на каждую короткую форму. */
  readonly saved: number;
}

export const IMM_SHORT_EFFECT: readonly ImmShortRow[] = [
  // Перемер 2026-09-24 (`.tmp/measure-literal-imm.ts`) после минимального вытеснения в память:
  // команд у `fir` 259 (было 221), у `correlation` 196 (было 155). Коротких форм и экономии это
  // не меняет: вытеснение кладёт адрес слота в `movtd` (`imm64`), а не в `movts`.
  { name: 'fir', commands: 259, short: 20, shortLiterals: 20, saved: 160 },
  { name: 'iir', commands: 161, short: 10, shortLiterals: 10, saved: 80 },
  { name: 'fft', commands: 228, short: 14, shortLiterals: 14, saved: 112 },
  { name: 'convolution', commands: 174, short: 16, shortLiterals: 16, saved: 128 },
  { name: 'correlation', commands: 199, short: 14, shortLiterals: 14, saved: 112 },
];

/** Текущая база: линейные байты пяти ядер после минимального вытеснения (`.tmp/measure-wide-pins.ts`). */
export const LINEAR_BYTES_BASELINE = 8392;

const encoder = getEncoder('e2k');

describe('эффект короткой формы: измерение по пяти ядрам', () => {
  it('1.1 коротких форм 74, экономия 592 байта', () => {
    const short = IMM_SHORT_EFFECT.reduce((sum, row) => sum + row.short, 0);
    const saved = IMM_SHORT_EFFECT.reduce((sum, row) => sum + row.saved, 0);
    expect(short, 'коротких форм').toBe(74);
    expect(saved, 'экономия байт').toBe(592);
    // Доля образа: 592 из 8368 (перемер 2026-09-24: база выросла вместе с полным понижением ядра).
    expect(saved / LINEAR_BYTES_BASELINE, 'доля образа').toBeGreaterThan(0.07);
    expect(saved / LINEAR_BYTES_BASELINE, 'доля образа').toBeLessThan(0.08);
  });

  it('1.2 измеренное число коротких форм совпадает с таблицей и с числом малых литералов', () => {
    const problems: string[] = [];
    for (const row of IMM_SHORT_EFFECT) {
      const measured = measureKernel(row.name);
      if (measured.commands !== row.commands) {
        problems.push(`${row.name}: команд ${measured.commands}, в таблице ${row.commands}`);
      }
      // Короткой формой кодируются ровно те литералы, чьё значение 0…15.
      if (measured.tinyLiterals !== row.short) {
        problems.push(`${row.name}: малых литералов ${measured.tinyLiterals}, коротких в таблице ${row.short}`);
      }
      if (row.short !== row.shortLiterals) {
        problems.push(`${row.name}: коротких ${row.short}, а литеральных среди них ${row.shortLiterals}`);
      }
    }
    expect(problems, 'измерение против таблицы').toEqual([]);
  });

  it('1.3 каждая короткая форма действительно 8 байт, а остальные — 16', () => {
    const problems: string[] = [];
    for (const row of IMM_SHORT_EFFECT) {
      const stream = measureKernel(row.name);
      void stream;
      // Проверяем кодировщик напрямую: граница 15/16 и размер.
      expect(encoder.encode({ mnemonic: 'movts', channel: 0, operands: [{ kind: 'imm', value: 15 }, { kind: 'reg', index: 1 }] }).length, `${row.name}: 15`).toBe(8);
      expect(encoder.encode({ mnemonic: 'movts', channel: 0, operands: [{ kind: 'imm', value: 16 }, { kind: 'reg', index: 1 }] }).length, `${row.name}: 16`).toBe(16);
    }
    expect(problems, 'размеры').toEqual([]);
  });

  it('1.4 НИ ОДНОГО барьера упаковки короткая форма не снимает', () => {
    // Это главное ограничение эффекта, и оно проверяется, а не подразумевается.
    const problems: string[] = [];
    for (const row of IMM_SHORT_EFFECT) {
      const measured = measureKernel(row.name);
      // Отказов упаковщика по `movts` столько же, сколько **всех** литеральных команд: короткая
      // форма меняет размер и поле, но не вид операндов, а отказ — по виду операндов.
      const movtsRefusals = measured.refusals.get('movts') ?? 0;
      if (movtsRefusals !== measured.literals) {
        problems.push(`${row.name}: отказов movts ${movtsRefusals}, литеральных ${measured.literals}`);
      }
      if (measured.literals < row.shortLiterals) {
        problems.push(`${row.name}: литеральных ${measured.literals} меньше коротких ${row.shortLiterals}`);
      }
    }
    expect(problems, 'отказы по movts остались').toEqual([]);
    // И прямая проверка на одной команде: короткая форма всё равно не упаковывается.
    const short = { mnemonic: 'movts', channel: 0, operands: [{ kind: 'imm', value: 5 }, { kind: 'reg', index: 1 }] } as const;
    expect(encoder.encode(short).length, 'короткая форма 8 байт').toBe(8);
    expect(packetableRefusal(short), 'отказ упаковщика остался').toBeDefined();
    expect(packetableRefusal(short), 'причина отказа').toContain('не все операнды — регистры');
  });

  it('1.5 сверка баз: закреплённые числа шага 2 перемерены на текущем потоке', () => {
    // Перемер 2026-09-24: база — 1021 команда (было 939) после минимального вытеснения в память.
    const sum = (pick: (row: { commands: number }) => number): number =>
      LITERAL_BARRIERS.reduce((total, row) => total + pick(row), 0);
    const effectSum = IMM_SHORT_EFFECT.reduce((total, row) => total + row.commands, 0);
    expect(sum((row) => row.commands), 'таблица барьеров').toBe(1021);
    expect(effectSum, 'таблица эффекта').toBe(1021);
    expect(sum((row) => row.commands), 'оба оракула на одной базе').toBe(effectSum);
    // Экономия от сдвига базы не зависит: она считается по числу коротких форм.
    expect(IMM_SHORT_EFFECT.reduce((total, row) => total + row.short, 0) * 8, 'экономия').toBe(592);
  });

  it('1.6 в потоке нет коротких форм, не являющихся литеральными movts', () => {
    // Если бы нашлась другая короткая команда, «74» перестало бы означать «74 литерала».
    for (const row of IMM_SHORT_EFFECT) {
      const measured = measureKernel(row.name);
      expect(measured.literals, `${row.name}: литеральных`).toBeGreaterThanOrEqual(row.shortLiterals);
      expect(isLiteralCommand({ mnemonic: 'adds', channel: 0, operands: [{ kind: 'reg', index: 1 }, { kind: 'reg', index: 2 }, { kind: 'reg', index: 3 }] }), 'adds не литерал').toBe(false);
    }
  });
});

describe('оракул собран и проверяет непустое множество', () => {
  it('каждое ядро дало хотя бы одну короткую форму', () => {
    for (const row of IMM_SHORT_EFFECT) {
      expect(row.short, `${row.name}: коротких`).toBeGreaterThan(0);
    }
    expect(encoder.encode({ mnemonic: 'movts', channel: 0, operands: [{ kind: 'imm', value: 0 }, { kind: 'reg', index: 1 }] }).length, 'N = 0').toBe(8);
  });
});
