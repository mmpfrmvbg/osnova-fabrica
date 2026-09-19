/**
 * ОРАКУЛ ГРУППИРОВКИ ИНСТРУКЦИЙ В ШИРОКИЕ КОМАНДЫ e2k.
 *
 * # Что проверяется
 *
 * `src/e2k/widePacker.ts` кладёт независимые операции в **одну** широкую команду (форма
 * извлечена в `docs/e2k-wide-commands.md`). Проверяются четыре утверждения:
 *
 * 1. две независимые операции → **одна** команда (пакет из 2 слогов);
 * 2. зависимые (`add` пишет регистр, который читает следующая) → **две** команды: RAW внутри
 *    пакета недопустим;
 * 3. три независимые → одна команда (3 слота);
 * 4. смесь независимых и зависимых → **максимальная** группировка без нарушения зависимостей;
 * 5. одиночная команда, которую паковать нельзя (литерал, управление), кодируется **теми же
 *    байтами**, что и раньше: группировка не меняет то, что не группируется.
 *
 * Прогон в QEMU (эквивалентность линейного и сгруппированного кода) — отдельный файл
 * `src/e2k/e2kWideQemu.test.ts`: он зависит от внешнего ресурса и в полном прогоне не живёт
 * (`docs/verification-debt.md`, случай 12).
 *
 * # Чего оракул НЕ доказывает
 *
 * Что пакеты **исполняются** как пакеты: это доказывает прогон (`e2kWideQemu.test.ts`), а здесь
 * проверяется только раскладка (сколько слогов в команде и какие байты).
 */

import { describe, it, expect } from 'vitest';
import { getEncoder, type AsmInstruction, type Operand } from './backend';
import { packWide, wideStats } from './widePacker';

const encoder = getEncoder('e2k');

const reg = (index: number, file?: 'base' | 'window'): Operand =>
  file === undefined ? { kind: 'reg', index } : { kind: 'reg', index, file };
const imm = (value: number): Operand => ({ kind: 'imm', value });

/** `adds` в форме ALF1: src1, src2, dst (`docs/e2k-wide-commands.md` §2.6). */
const add = (src1: number, src2: number, dst: number, file?: 'base' | 'window'): AsmInstruction => ({
  mnemonic: 'adds',
  channel: 0,
  operands: [reg(src1), reg(src2), reg(dst, file)],
});

/** `muls` в форме ALF11: слог ALS + полуслог ALES (16 байт в одиночной команде). */
const mul = (src1: number, src2: number, dst: number): AsmInstruction => ({
  mnemonic: 'muls',
  channel: 0,
  operands: [reg(src1), reg(src2), reg(dst)],
});

describe('группировка: независимые операции', () => {
  it('3.1 две независимые add → одна команда из двух слогов', () => {
    const instructions = [add(1, 2, 3), add(4, 5, 6)];
    const packets = packWide(instructions);
    expect(packets.length, 'пакетов').toBe(1);
    expect(packets[0]!.slots.length, 'слогов в пакете').toBe(2);
    // 8 байт на слог не хватает: HS + два ALS = 3 слова, добивка до 4 → 16 байт.
    expect(packets[0]!.bytes.length).toBe(16);
    // Каналы в пакете обязаны быть разными: две операции в один ALC — отказ ассемблера.
    expect(new Set(packets[0]!.slots.map((slot) => slot.channel)).size).toBe(2);
  });

  it('3.3 три независимые add → одна команда из трёх слогов', () => {
    const packets = packWide([add(1, 2, 3), add(4, 5, 6), add(7, 8, 9)]);
    expect(packets.length).toBe(1);
    expect(packets[0]!.slots.length).toBe(3);
    // HS + 3 ALS = 4 слова = 16 байт: добивка не нужна (чётное число слогов).
    expect(packets[0]!.bytes.length).toBe(16);
  });

  it('шесть независимых add → одна команда: шесть — предел каналов ALS', () => {
    const instructions = [0, 1, 2, 3, 4, 5].map((index) => add(index + 1, index + 7, index + 13));
    const packets = packWide(instructions);
    expect(packets.length).toBe(1);
    expect(packets[0]!.slots.length).toBe(6);
  });

  it('две независимые muls (ALF11) → одна команда: полуслоги ALES делят слово', () => {
    const packets = packWide([mul(1, 2, 3), mul(4, 5, 6)]);
    expect(packets.length, 'пакетов').toBe(1);
    expect(packets[0]!.slots.length, 'слогов').toBe(2);
    // HS + ALS0 + ALS1 + слово ALES = 4 слова = 16 байт (в одиночку muls — тоже 16).
    expect(packets[0]!.bytes.length).toBe(16);
  });
});

describe('группировка: зависимости', () => {
  it('3.2 зависимые add → две команды (RAW внутри пакета недопустим)', () => {
    // Вторая читает регистр, который пишет первая.
    const instructions = [add(1, 2, 3), add(3, 2, 7)];
    const packets = packWide(instructions);
    expect(packets.length, 'пакетов').toBe(2);
    expect(packets.map((packet) => packet.slots.length)).toEqual([1, 1]);
  });

  it('WAR и WAW тоже разделяют пакеты', () => {
    // WAR: первая читает b3, вторая пишет b3.
    expect(packWide([add(3, 2, 9), add(1, 2, 3)]).length, 'WAR').toBe(2);
    // WAW: обе пишут b3.
    expect(packWide([add(1, 2, 3), add(4, 5, 3)]).length, 'WAW').toBe(2);
  });

  it('3.4 смесь: максимальная группировка без нарушения зависимостей', () => {
    // i0: b3 = b1 + b2;  i1: b6 = b4 + b5 (независима от i0);  i2: b7 = b3 + b2 (зависит от i0)
    const instructions = [add(1, 2, 3), add(4, 5, 6), add(3, 2, 7)];
    const packets = packWide(instructions);
    expect(packets.length, 'пакетов').toBe(2);
    expect(packets.map((packet) => packet.slots.length), 'слогов в пакетах').toEqual([2, 1]);
    // Порядок сохранён: i0 и i1 в первом пакете, i2 — во втором.
    expect(packets[0]!.slots[0]!.instruction.operands[2]).toEqual(reg(3));
    expect(packets[1]!.slots[0]!.instruction.operands[2]).toEqual(reg(7));
  });

  it('зависимость по регистру окна учитывается так же, как по базовому', () => {
    // b3 (базовый) и r3 (оконный) — разные регистры: паковать можно.
    expect(packWide([add(1, 2, 3), add(3, 2, 9, 'window')]).length, 'разные файлы регистров').toBe(1);
    // Один и тот же оконный регистр — нельзя.
    expect(packWide([add(1, 2, 9, 'window'), add(9, 2, 10, 'window')]).length, 'тот же оконный').toBe(2);
  });
});

describe('группировка: что не группируется', () => {
  it('команда с литералом остаётся одиночной и кодируется прежними байтами', () => {
    const literal: AsmInstruction = { mnemonic: 'movts', channel: 0, operands: [imm(4), reg(8, 'window')] };
    const packets = packWide([literal]);
    expect(packets.length).toBe(1);
    expect(packets[0]!.slots.length).toBe(1);
    expect(Array.from(packets[0]!.bytes)).toEqual(Array.from(encoder.encode(literal)));
  });

  it('литерал разделяет пакеты: операции по разные стороны от него не сливаются', () => {
    const literal: AsmInstruction = { mnemonic: 'movts', channel: 0, operands: [imm(4), reg(8, 'window')] };
    const packets = packWide([add(1, 2, 3), literal, add(4, 5, 6)]);
    expect(packets.length, 'пакетов').toBe(3);
  });

  it('отказ: неизвестная мнемоника называется причиной, а не молчанием', () => {
    const unknown: AsmInstruction = { mnemonic: 'нет-такой', channel: 0, operands: [reg(1), reg(2), reg(3)] };
    const packets = packWide([unknown]);
    expect(packets.length).toBe(1);
    expect(packets[0]!.slots.length).toBe(1);
    expect(packets[0]!.refusal, 'причина отказа не названа').toBeDefined();
  });
});

describe('группировка: замер', () => {
  it('счёт команд и байтов: линейно против пакетов', () => {
    const instructions = [add(1, 2, 3), add(4, 5, 6), add(7, 8, 9), mul(10, 11, 12)];
    const stats = wideStats(instructions);
    expect(stats.linearCommands, 'команд линейно').toBe(4);
    expect(stats.packets, 'пакетов').toBeLessThan(4);
    expect(stats.bytesWide, 'байт в пакетах').toBeLessThanOrEqual(stats.bytesLinear);
  });
});
