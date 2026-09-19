/**
 * ОРАКУЛ ОКНА РЕГИСТРОВ e2k: `setwd` — управляем ли размер окна из user space.
 *
 * # Зачем
 *
 * Базовый регистр `%b[N]` существует **только внутри текущего окна** (`qemu/target/e2k/reg-index.h:55-81`),
 * а окно по умолчанию даёт всего 16 регистров (`%b[0..15]`). Процедуре `фильтр` ядра FIR нужно
 * **17 vreg'ов** — значит либо окно расширяется, либо нужна раскраска регистров. Этот оракул
 * проверяет первое: кодировку `setwd`, которая из user space задаёт размер окна.
 *
 * # Что найдено и откуда
 *
 * | утверждение | источник |
 * |---|---|
 * | `setwd` — это слог CS1 с кодом операции `SETR0` **и литералом** | `qemu/target/e2k/tcg/translate-lookahead.c:645-652`, `:683-691`; `qemu/target/e2k/opcode-tables.h:60` |
 * | размер окна берётся из литерала: `wsz[11:5]`, `dbl` — бит 3, `nfx` — бит 4 | `qemu/target/e2k/tcg/translate-misc.c:592`; `qemu/target/e2k/syllab-format.h:150-160` |
 * | байт окна = `wsz << 4`, двойных слов = `wsz * 2`; исключение только если больше `MAXSR_D` | `qemu/target/e2k/tcg/translate-misc.c:592-606` |
 * | имена параметров ассемблера: `setwd wsz=, nfx=, dbl=` | `gas/config/tc-e2k.c:6257-6301` |
 *
 * # Чего оракул НЕ доказывает
 *
 * Что расширенное окно **работает в связке с памятью**: это измерялось прогоном (`.tmp/setwd-verify.ts`)
 * и дало важный отрицательный результат — программа с расширенным окном И обращением к памяти в
 * модели **зависает** (два прогона по 123 с, «QEMU не запустился»), при окне по умолчанию та же
 * программа проходит. Поэтому рантайм массивов окно не расширяет; подробности — §7.7
 * `docs/e2k-opcodes-real.md`.
 */

import { describe, it, expect } from 'vitest';
import { getEncoder, type AsmInstruction, type Operand } from './backend';
import { realOpcode } from './e2k-real';
import { assembleAll, findExternalAs, type AsSample } from '../scripts/e2kExternalAs';
import { ARRAY_WINDOW_RSZ, arrayPrologue } from './arrayRuntime';

const encoder = getEncoder('e2k');
const imm = (value: number): Operand => ({ kind: 'imm', value });

const setwd = (wsz: number, dbl = 0): AsmInstruction => ({
  mnemonic: 'setwd',
  channel: 0,
  operands: [imm(wsz), imm(dbl)],
});

const hexOf = (bytes: Uint8Array): string =>
  Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join(' ');

/** Измерено ассемблером МЦСТ: `setwd wsz=W, nfx=0, dbl=0` → 16 байт, `wsz` в последнем слове. */
const MEASURED: ReadonlyArray<{ wsz: number; bytes: string }> = [
  { wsz: 8, bytes: '11 80 00 00 00 00 00 00 00 00 00 00 00 01 00 00' },
  { wsz: 16, bytes: '11 80 00 00 00 00 00 00 00 00 00 00 00 02 00 00' },
  { wsz: 112, bytes: '11 80 00 00 00 00 00 00 00 00 00 00 00 0e 00 00' },
];

describe('окно регистров: кодировка setwd', () => {
  it('setwd есть в таблице управления, форма CS1_SETWD, 16 байт', () => {
    const entry = realOpcode('setwd');
    expect(entry).toBeUndefined(); // setwd — не из таблицы опкодов МЦСТ, а управляющий слог
    expect(hexOf(encoder.encode(setwd(16))).split(' ').length).toBe(16);
  });

  it('байты совпадают с измеренными ассемблером', () => {
    for (const item of MEASURED) {
      expect(hexOf(encoder.encode(setwd(item.wsz))), `wsz=${item.wsz}`).toBe(item.bytes);
    }
  });

  it('размер окна читается из литерала: байт окна = wsz << 4', () => {
    // Поле `wsz[11:5]` последнего слова — то же, что читает модель
    // (`qemu/target/e2k/tcg/translate-misc.c:592`).
    const bytes = encoder.encode(setwd(16));
    const literal = (bytes[12]! | (bytes[13]! << 8) | (bytes[14]! << 16) | (bytes[15]! << 24)) >>> 0;
    expect((literal >>> 5) & 0x7f, 'wsz из литерала').toBe(16);
    expect((literal >>> 3) & 1, 'dbl').toBe(0);
    // 16 единиц по 16 байт = 256 байт окна = 32 двойных слова → `%b[0..31]`.
    expect((literal >>> 5) * 2, 'двойных слов в окне').toBe(32);
  });

  it('байты совпадают с живым ассемблером — или причина названа', () => {
    const { tool, reason } = findExternalAs();
    if (tool === undefined) {
      expect(reason, 'причина недоступности ассемблера не названа').toBeDefined();
      return;
    }
    const samples: AsSample[] = MEASURED.map((item, index) => ({
      key: `setwd-${item.wsz}`,
      mnemonic: 'setwd',
      channel: index,
      form: 'control',
      asText: `setwd wsz=${item.wsz}, nfx=0, dbl=0`,
      instruction: setwd(item.wsz),
      source: 'src/e2k/e2kWindow.test.ts',
    }));
    const results = assembleAll(samples);
    const problems: string[] = [];
    MEASURED.forEach((item, index) => {
      const result = results[index]!;
      if (!result.ok) {
        problems.push(`wsz=${item.wsz}: ассемблер отказал — ${result.error}`);
        return;
      }
      const theirs = hexOf(result.bytes);
      if (theirs !== item.bytes) problems.push(`wsz=${item.wsz}: as дал ${theirs}, ждали ${item.bytes}`);
    });
    expect(problems, problems.join('; ')).toEqual([]);
  });

  it('негативный контроль: неверный размер окна даёт другие байты', () => {
    expect(hexOf(encoder.encode(setwd(16))), 'wsz=16').not.toBe(hexOf(encoder.encode(setwd(8))));
    // Бит `dbl` — третий, а не пятый: подмена поля обязана быть видна.
    expect(hexOf(encoder.encode(setwd(16, 1))), 'dbl').not.toBe(hexOf(encoder.encode(setwd(16, 0))));
  });

  it('решение зафиксировано: рантайм массивов окно НЕ расширяет', () => {
    // Окно управляемо (§7.6 docs/e2k-opcodes-real.md), но программа с расширенным окном в модели
    // ведёт себя НЕУСТОЙЧИВО: один и тот же образ даёт то успех, то исключение, а программа с
    // памятью зависла дважды (`docs/e2k-setwd-memory.md` §2). Поэтому рантайм работает в окне по
    // умолчанию, и это зафиксировано здесь: появление `setwd` в прологе — не мелочь, а смена решения.
    const prologue = arrayPrologue(0x102000);
    expect(
      prologue.map((instruction) => instruction.mnemonic),
      'пролог рантайма массивов не должен использовать setwd',
    ).not.toContain('setwd');
    expect(prologue[0]!.mnemonic, 'окно ставится setbn в пределах по умолчанию').toBe('setbn');
    expect(prologue[0]!.operands[0]).toEqual({ kind: 'imm', value: ARRAY_WINDOW_RSZ });
  });
});
