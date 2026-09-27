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
 * 5. одиночная команда, которую паковать нельзя (управление, 64-битный литерал), кодируется **теми
 *    же байтами**, что и раньше: группировка не меняет то, что не группируется.
 *
 * Прогон в QEMU (эквивалентность линейного и сгруппированного кода) — отдельный файл
 * `src/e2k/e2kWideQemu.test.ts`: он зависит от внешнего ресурса и в полном прогоне не живёт
 * (`docs/verification-debt.md`, случай 12).
 *
 * # Что изменилось 2026-09-27: литерал перестал быть барьером
 *
 * В пункте 5 прежде стоял и литерал. Теперь он упаковщиком **берётся** (раскладка измерена,
 * `src/e2k/e2kWideSsLts.test.ts`), поэтому проверка «литерал разделяет пакеты» заменена на обратную:
 * литерал едет в одной команде с соседями, и слогов в ней столько же, сколько инструкций.
 *
 * # Чего оракул НЕ доказывает
 *
 * Что пакеты **исполняются** как пакеты: это доказывает прогон (`e2kWideQemu.test.ts`), а здесь
 * проверяется только раскладка (сколько слогов в команде и какие байты).
 */

import { describe, it, expect } from 'vitest';
import { getEncoder, type AsmInstruction, type Operand } from './backend';
import { packWide, wideStats, wideBytes } from './widePacker';
import { assembleAll, findExternalAs, type AsSample } from '../scripts/e2kExternalAs';
import { hexOf } from '../scripts/e2kWideCommands.audit.test';

const encoder = getEncoder('e2k');

/** Байты → hex: тот же формат, что в документе и отчётах. */
const hexOf = (bytes: Uint8Array): string =>
  Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join(' ');

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
    // Оконные r1/r2/r9 и базовые b1/b2/b9 — разные регистры: паковать можно.
    const windowAdd = (src1: number, src2: number, dst: number): AsmInstruction => ({
      mnemonic: 'adds',
      channel: 0,
      operands: [reg(src1, 'window'), reg(src2, 'window'), reg(dst, 'window')],
    });
    expect(packWide([add(1, 2, 3), windowAdd(1, 2, 9)]).length, 'разные файлы регистров').toBe(1);
    // Один и тот же оконный регистр: вторая читает то, что пишет первая, — RAW.
    expect(packWide([windowAdd(1, 2, 9), windowAdd(9, 2, 10)]).length, 'тот же оконный').toBe(2);
    // И базовый b3 не «тот же», что оконный r3: чтение оконного r3 не зависит от записи базового b3.
    expect(
      packWide([add(1, 2, 3), { mnemonic: 'adds', channel: 0, operands: [reg(3, 'window'), reg(2), reg(9)] }]).length,
      'базовый против оконного',
    ).toBe(1);
  });
});

describe('группировка: что не группируется', () => {
  it('одиночный литерал кодируется прежними байтами — короткой формой, а не широкой командой', () => {
    // Значение 4 попадает в короткую непосредственную форму (0…15): это 8 байт, а не 16 с LTS.
    const literal: AsmInstruction = { mnemonic: 'movts', channel: 0, operands: [imm(4), reg(8, 'window')] };
    const packets = packWide([literal]);
    expect(packets.length).toBe(1);
    expect(packets[0]!.slots.length).toBe(1);
    expect(Array.from(packets[0]!.bytes)).toEqual(Array.from(encoder.encode(literal)));
  });

  it('литерал БОЛЬШЕ не разделяет пакеты: он едет в одной команде с соседями', () => {
    // Перемер 2026-09-27: прежде литерал был барьером (`packetableRefusal`) и здесь требовалось
    // «пакетов 3». Литерал включён в упаковщик, поэтому три инструкции собираются в ОДНУ команду.
    const literal: AsmInstruction = { mnemonic: 'movts', channel: 0, operands: [imm(4), reg(8, 'window')] };
    const packets = packWide([add(1, 2, 3), literal, add(4, 5, 6)]);
    expect(packets.length, 'пакетов').toBe(1);
    expect(packets[0]!.slots.length, 'слогов в команде').toBe(3);
  });

  it('отказ: неизвестная мнемоника называется причиной, а не молчанием', () => {
    const unknown: AsmInstruction = { mnemonic: 'нет-такой', channel: 0, operands: [reg(1), reg(2), reg(3)] };
    const packets = packWide([unknown]);
    expect(packets.length).toBe(1);
    expect(packets[0]!.slots.length).toBe(1);
    expect(packets[0]!.refusal, 'причина отказа не названа').toBeDefined();
  });
});

describe('группировка: внешняя сверка с ассемблером МЦСТ', () => {
  /** Ассемблерный текст набора: пакеты так, как их назначил группировщик. */
  const asTextOf = (instructions: readonly AsmInstruction[]): string => {
    const lines: string[] = [];
    for (const packet of packWide(instructions)) {
      const text = (slot: { instruction: AsmInstruction; channel: number }): string =>
        `${slot.instruction.mnemonic},${slot.channel} ` +
        slot.instruction.operands
          .map((operand) => (operand.kind === 'reg' ? `%b[${operand.index}]` : '<не регистр>'))
          .join(', ');
      if (packet.slots.length === 1) {
        lines.push(text(packet.slots[0]!));
        continue;
      }
      lines.push('{');
      for (const slot of packet.slots) lines.push(text(slot));
      lines.push('}');
    }
    return lines.join('\n');
  };

  const CASES: ReadonlyArray<{ key: string; instructions: AsmInstruction[] }> = [
    { key: 'add+add', instructions: [add(1, 2, 3), add(4, 5, 6)] },
    { key: 'add+add+add', instructions: [add(1, 2, 3), add(4, 5, 6), add(7, 8, 9)] },
    {
      key: 'add+sub',
      instructions: [add(1, 2, 3), { mnemonic: 'subs', channel: 0, operands: [reg(4), reg(5), reg(6)] }],
    },
    { key: 'mul+mul (ALES делят слово)', instructions: [mul(1, 2, 3), mul(4, 5, 6)] },
    { key: 'mul+add', instructions: [mul(1, 2, 3), add(4, 5, 6)] },
    { key: 'mul+mul+add', instructions: [mul(1, 2, 3), mul(4, 5, 6), add(7, 8, 9)] },
  ];

  it('байты группировщика совпадают с ассемблером побайтово — или причина названа', () => {
    const { tool, reason } = findExternalAs();
    if (tool === undefined) {
      expect(reason, 'причина недоступности ассемблера не названа').toBeDefined();
      expect(reason!.length).toBeGreaterThan(20);
      return;
    }
    const samples: AsSample[] = CASES.map((item, index) => ({
      key: item.key,
      mnemonic: 'adds',
      channel: index,
      form: 'ALF1',
      asText: asTextOf(item.instructions),
      instruction: item.instructions[0]!,
      source: 'src/e2k/widePackets.test.ts',
    }));
    const results = assembleAll(samples);
    const problems: string[] = [];
    CASES.forEach((item, index) => {
      const result = results[index]!;
      const ours = hexOf(wideBytes(packWide(item.instructions)));
      if (!result.ok) {
        problems.push(`«${item.key}»: ассемблер отказал — ${result.error}`);
        return;
      }
      const theirs = hexOf(result.bytes);
      if (ours !== theirs) problems.push(`«${item.key}»: наши ${ours}, ассемблер ${theirs}`);
    });
    expect(problems, problems.join('; ')).toEqual([]);
  });

  it('негативный контроль сверки: подмена байтов расхождение показывает', () => {
    // Сверка сравнивает hex, поэтому подменённые байты обязаны дать расхождение — иначе она
    // сравнивала бы что-то другое.
    const packets = packWide([add(1, 2, 3), add(4, 5, 6)]);
    const ours = hexOf(wideBytes(packets));
    const mutated = new Uint8Array(wideBytes(packets));
    mutated[0] = (mutated[0]! ^ 0xff) & 0xff;
    expect(hexOf(mutated)).not.toBe(ours);
  });
});

describe('группировка: замер', () => {
  it('счёт команд и байтов: линейно против пакетов', () => {
    const instructions = [add(1, 2, 3), add(4, 5, 6), add(7, 8, 9), mul(10, 11, 12)];
    const stats = wideStats(instructions);
    expect(stats.linearCommands, 'команд линейно').toBe(4);
    expect(stats.packets, 'пакетов').toBeLessThan(4);
    expect(stats.bytesWide, 'байт в пакетах').toBeLessThanOrEqual(stats.bytesLinear);
    expect(stats.refused, 'отказов кодировщика').toBe(0);
  });

  it('замер не падает на инструкции, которую кодировщик отвергает, а считает её', () => {
    // Носитель `IR.*` одиночный кодировщик отвергает — замер обязан назвать это числом, а не
    // упасть: иначе замер по потоку ядра невозможен (там 131 такой носитель).
    const carrier: AsmInstruction = { mnemonic: 'IR.invoke', channel: 0, operands: [reg(1), reg(2)] };
    const stats = wideStats([add(1, 2, 3), carrier]);
    expect(stats.refused, 'отказов кодировщика').toBe(1);
    expect(stats.linearCommands).toBe(2);
  });
});
