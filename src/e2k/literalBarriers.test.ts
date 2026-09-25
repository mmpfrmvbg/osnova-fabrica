/**
 * ОРАКУЛ LTS-БАРЬЕРОВ: ЧТО РАЗРЫВАЕТ ПАКЕТЫ В ПОТОКЕ ПЯТИ ЯДЕР.
 *
 * # Зачем это нужно (шаг 2)
 *
 * `packWide` отказывается класть в широкую команду то, что не является короткой операцией ALS
 * (`src/e2k/widePacker.ts:80-95`), и называет причину. Замер шага 1 показал, что упаковка сама по
 * себе даёт 1.7 % — значит материал группировки надо искать. Этот оракул отвечает числом:
 * **сколько** команд являются литеральными (`movts` с LTS) и **сколько** — препятствия другого
 * рода, которые снятием литералов не снимаются.
 *
 * # Различение барьеров: три разные вещи, которые легко смешать
 *
 * 1. **Литеральный `movts`** — 16 байт, кодируется слогом **LTS** (`src/e2k/e2k-real.ts:993-1037`).
 *    Это и есть литеральный барьер: `packetableRefusal` отказывает по «не все операнды — регистры».
 * 2. **Длинная форма** `muls` (ALF11) — тоже 16 байт, но литерала в ней **нет**: длину даёт
 *    полуслог ALES. Барьером LTS она не является, и снятие литералов её не касается.
 * 3. **Управляющие команды** `call`, `disp`, `ct`, `return` — 8 или 16 байт, но у них **нет слога
 *    ALS вообще**: это слоги CS/SS. Они не станут пакетом ни при каком снятии литералов.
 *
 * Признак «16 байт» смешал бы все три — именно так и вышло в первой редакции замера (91 вместо
 * 78). Поэтому ниже барьер определяется **мнемоникой и видом операндов**, а не длиной.
 *
 * # Числа закреплены, а не считаются на лету
 *
 * Таблица — **измерение** по закоммиченному потоку. Чтобы оракул не стал слепым к ошибке в самом
 * замере, измеренное сравнивается с таблицей, а не наоборот.
 */

import { describe, it, expect } from 'vitest';
import { packetableRefusal } from './widePacker';
import { kernelStreamOf } from './e2kWideFir.test';
import type { AsmInstruction } from './backend';

const ATOMS: Readonly<Record<string, string>> = {
  fir: 'A5',
  iir: 'A5',
  fft: 'A5',
  convolution: 'A6',
  correlation: 'A6',
};

/** Литеральная ли команда: `movts` с непосредственным операндом (кодируется слогом LTS). */
export function isLiteralCommand(command: AsmInstruction): boolean {
  if (command.mnemonic !== 'movts') return false;
  return command.operands.some((operand) => operand.kind === 'imm');
}

/** Управляющая ли команда: слог CS/SS, слога ALS нет вовсе. */
export function isControlCommand(command: AsmInstruction): boolean {
  return ['call', 'disp', 'ct', 'return', 'sdisp', 'setbn', 'setwd'].includes(command.mnemonic);
}

/** Длинная ли форма ALF11 (ALS + ALES): литерал в ней не реализован. */
export function isLongFormCommand(command: AsmInstruction): boolean {
  return command.mnemonic === 'muls';
}

/** Измеренные величины по пяти ядрам. */
export interface LiteralBarrierRow {
  readonly name: string;
  readonly commands: number;
  /** Литеральные `movts` (LTS): снимаемый барьер. */
  readonly literals: number;
  /** Из них со значением 0…15 — их ассемблер МЦСТ кладёт короткой непосредственной формой. */
  readonly tinyLiterals: number;
  /** Управляющие команды: барьер обязательный. */
  readonly control: number;
  /** Длинная форма ALF11: барьер не литеральный. */
  readonly longForm: number;
  readonly packets: number;
  readonly emptySlots: number;
}

export const LITERAL_BARRIERS: readonly LiteralBarrierRow[] = [
  // Перемер 2026-09-24 (`.tmp/measure-literal-imm.ts`) после минимального вытеснения в память:
  // ядро `fir` понижается ЦЕЛИКОМ (259 команд вместо 221, управляющих 22 вместо 20 — вытеснение
  // добавляет `movtd`, который управляющей командой не является, но поток стал длиннее), у
  // `correlation` — 196 команд вместо 155. Литералов на ядрах не прибавилось: вытеснение кладёт
  // адрес слота в `movtd` (`imm64`), а не в `movts`.
  { name: 'fir', commands: 259, literals: 20, tinyLiterals: 20, control: 22, longForm: 1, packets: 220, emptySlots: 1061 },
  // Перемер 2026-09-25: у `iir` 158 команд (было 161) — трюк `(a - a % b) / b` заменён на `div`.
  { name: 'iir', commands: 158, literals: 14, tinyLiterals: 10, control: 22, longForm: 2, packets: 133, emptySlots: 640 },
  { name: 'fft', commands: 228, literals: 14, tinyLiterals: 14, control: 14, longForm: 0, packets: 197, emptySlots: 954 },
  {
    name: 'convolution',
    commands: 232,
    literals: 16,
    tinyLiterals: 16,
    control: 26,
    longForm: 1,
    packets: 205,
    emptySlots: 998,
  },
  {
    name: 'correlation',
    commands: 199,
    literals: 14,
    tinyLiterals: 14,
    control: 22,
    longForm: 1,
    packets: 169,
    emptySlots: 815,
  },
];

/** Измерение по одному ядру. */
export function measureKernel(name: string): {
  readonly commands: number;
  readonly literals: number;
  readonly tinyLiterals: number;
  readonly control: number;
  readonly longForm: number;
  readonly refusals: ReadonlyMap<string, number>;
} {
  const stream = kernelStreamOf(name, ATOMS[name]!);
  let literals = 0;
  let tinyLiterals = 0;
  let control = 0;
  let longForm = 0;
  const refusals = new Map<string, number>();
  for (const command of stream.commands) {
    if (isLiteralCommand(command)) {
      literals++;
      const imm = command.operands.find((operand) => operand.kind === 'imm');
      if (imm !== undefined && imm.kind === 'imm' && imm.value >= 0 && imm.value <= 15) tinyLiterals++;
    }
    if (isControlCommand(command)) control++;
    if (isLongFormCommand(command)) longForm++;
    const refusal = packetableRefusal(command);
    if (refusal !== undefined) refusals.set(command.mnemonic, (refusals.get(command.mnemonic) ?? 0) + 1);
  }
  return { commands: stream.commands.length, literals, tinyLiterals, control, longForm, refusals };
}

describe('LTS-барьеры: что именно разрывает пакеты', () => {
  it('1.1 измеренное число команд совпадает с таблицей', () => {
    const problems: string[] = [];
    for (const row of LITERAL_BARRIERS) {
      const measured = measureKernel(row.name);
      if (measured.commands !== row.commands) {
        problems.push(`${row.name}: команд ${measured.commands}, в таблице ${row.commands}`);
      }
    }
    expect(problems, 'число команд').toEqual([]);
  });

  it('1.2 литеральные команды — это `movts` с непосредственным операндом', () => {
    const problems: string[] = [];
    for (const row of LITERAL_BARRIERS) {
      const measured = measureKernel(row.name);
      if (measured.literals !== row.literals) {
        problems.push(`${row.name}: литеральных ${measured.literals}, в таблице ${row.literals}`);
      }
    }
    expect(problems, 'литеральные команды').toEqual([]);
    // И все они получают отказ упаковщика именно по литералу — иначе это не барьер.
    const fir = kernelStreamOf('fir', 'A5');
    const literalRefusals = fir.commands
      .filter(isLiteralCommand)
      .map((command) => packetableRefusal(command))
      .filter((reason): reason is string => reason !== undefined);
    expect(literalRefusals.length, 'литеральных с отказом').toBe(LITERAL_BARRIERS[0]!.literals);
    expect(
      literalRefusals.every((reason) => reason.includes('не все операнды — регистры')),
      'причина отказа у литеральных',
    ).toBe(true);
  });

  it('1.3 барьеры различены: управляющие команды и длинная форма — не литералы', () => {
    const problems: string[] = [];
    for (const row of LITERAL_BARRIERS) {
      const measured = measureKernel(row.name);
      if (measured.control !== row.control) problems.push(`${row.name}: управляющих ${measured.control}, в таблице ${row.control}`);
      if (measured.longForm !== row.longForm) problems.push(`${row.name}: длинных форм ${measured.longForm}, в таблице ${row.longForm}`);
    }
    expect(problems, 'управляющие команды и длинная форма').toEqual([]);
    // Различение проверяется прямо: `call` 16 байт, но литералом не является.
    const call: AsmInstruction = { mnemonic: 'call', channel: 0, operands: [{ kind: 'imm', value: 1 }, { kind: 'imm', value: 4 }] };
    expect(isLiteralCommand(call), 'call литералом не является').toBe(false);
    expect(isControlCommand(call), 'call управляющая').toBe(true);
    const muls: AsmInstruction = { mnemonic: 'muls', channel: 0, operands: [{ kind: 'reg', index: 1 }, { kind: 'reg', index: 2 }, { kind: 'reg', index: 3 }] };
    expect(isLiteralCommand(muls), 'muls литералом не является').toBe(false);
    expect(isLongFormCommand(muls), 'muls длинная форма').toBe(true);
  });

  it('1.4 значения литералов: почти все влезают в короткую непосредственную форму', () => {
    const problems: string[] = [];
    for (const row of LITERAL_BARRIERS) {
      const measured = measureKernel(row.name);
      if (measured.tinyLiterals !== row.tinyLiterals) {
        problems.push(`${row.name}: значений 0..15 — ${measured.tinyLiterals}, в таблице ${row.tinyLiterals}`);
      }
      if (measured.tinyLiterals === 0) problems.push(`${row.name}: ни одного литерала со значением 0..15`);
    }
    expect(problems, 'короткая непосредственная форма').toEqual([]);
  });

  it('1.5 итог: 78 литеральных из 1076 команд, управляющих 106', () => {
    const sum = (pick: (row: LiteralBarrierRow) => number): number => LITERAL_BARRIERS.reduce((total, row) => total + pick(row), 0);
    // Перемер 2026-09-25 (`.tmp/measure-literal-imm.ts`) после замены трюка на `div`: команд 1076
    // (было 1079 — у `iir` ушли вызов остатка и вычитание), литеральных 78 и «малых» 74 не изменились.
    expect(sum((row) => row.commands), 'команд').toBe(1076);
    expect(sum((row) => row.literals), 'литеральных').toBe(78);
    expect(sum((row) => row.tinyLiterals), 'со значением 0..15').toBe(74);
    expect(sum((row) => row.control), 'управляющих').toBe(106);
    expect(sum((row) => row.longForm), 'длинных форм').toBe(5);
  });

  it('1.6 пустые слоты: 4468 из 5544 — база сдвинулась вытеснением в память', () => {
    const packets = LITERAL_BARRIERS.reduce((sum, row) => sum + row.packets, 0);
    const empty = LITERAL_BARRIERS.reduce((sum, row) => sum + row.emptySlots, 0);
    // Перемер 2026-09-25: пакетов 924 (было 927), пустых слотов 4468 (было 4483), слогов 5544.
    expect(packets, 'пакетов').toBe(924);
    expect(empty, 'пустых слотов').toBe(4468);
    expect(packets * 6, 'слогов всего').toBe(5544);
    expect(packets * 6 - empty, 'занятых слотов').toBe(1076);
    // Прежние числа (783 / 3759 / 4698) относились к потоку до вытеснения; числа 927 / 4483 — к
    // потоку с вытеснением, но ещё с трюком через остаток у `iir`.
    expect(packets, 'пакетов на потоке интеграции').toBe(924);
  });
});

describe('оракул собран и проверяет непустое множество', () => {
  it('каждое ядро дало хотя бы один литерал и хотя бы одну управляющую команду', () => {
    for (const row of LITERAL_BARRIERS) {
      const measured = measureKernel(row.name);
      expect(measured.literals, `${row.name}: литералов`).toBeGreaterThan(0);
      expect(measured.control, `${row.name}: управляющих`).toBeGreaterThan(0);
    }
  });

  it('отказы упаковщика непусты и распределены по мнемоникам', () => {
    const fir = measureKernel('fir');
    expect(fir.refusals.size, 'мнемоник с отказом').toBeGreaterThan(3);
    expect(fir.refusals.get('movts'), 'отказов movts').toBeGreaterThan(0);
  });
});
