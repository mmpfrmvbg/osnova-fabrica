/**
 * ОРАКУЛ ФОРМЫ 0xdc — 64-БИТНЫЙ ЛИТЕРАЛ (`movtd,0 _f64 …`).
 *
 * # Зачем форма нужна
 *
 * Без неё **нет адреса**: в e2k адрес строки — 64-битное значение, а носитель `IR.const` несёт
 * 32-битный литерал (`movts,0 …`). «Hello, world» через syscall `write` требует положить 64-битный
 * адрес буфера, то есть литерал формы `0xdc` — два LTS-слова. Сейчас путь 64-битного литерала
 * **отвергается** (`src/e2k/e2k-real.ts`, разбор: «НЕТ В ИСТОЧНИКЕ: 64-битный литерал (поле
 * 0xdc) не реализован»), и это названный отказ, а не молчаливый пропуск.
 *
 * # Что измерено ассемблером МЦСТ (эталон, а не пересказ)
 *
 * | текст | байты |
 * |---|---|
 * | `movtd,0 _f64 0x100000, %r8` | `11 00 00 04 88 dc c0 61` + `00 00 00 00 00 00 10 00` |
 * | `movtd,0 _f64 0xdeadbeefcafebabe, %r8` | слова литерала `ef be ad de` `be ba fe ca` |
 *
 * Поле ссылки на литерал — `0xdc` (`opcodes/e2k-dis.c:485`: «`(v & 0xfc) == 0xdc` — 64-битный
 * литерал, занимает **два** LTS-слова»; `gas/config/tc-e2k.c:2006`: 64 бита → 4 полуслова).
 * Раскладка слов в оракуле задана **измеренными** последовательностями: старшее слово первым.
 *
 * # Почему новый вид операнда
 *
 * `0xdeadbeefcafebabe` в `number` не представимо (больше 2⁵³), а усечение до 32 бит — молчаливая
 * потеря. Поэтому форма выражается **отдельным видом операнда** (`imm64`, значение `bigint`):
 * он же и выбирает 64-битную форму — иначе `0x100000`, влезающий в 32 бита, был бы закодирован
 * короткой формой и адрес потерялся бы.
 *
 * # Чего оракул НЕ доказывает
 *
 * Что байты примет железо: `as` и `objdump` — инструменты кодировки (внешняя сверка — в
 * `src/scripts/e2kExternalAs.test.ts`), а не исполнение. Исполнение проверяется отдельно: syscall
 * `write` в QEMU.
 */

import { describe, it, expect } from 'vitest';
import {
  EncodingRefusedError,
  getEncoder,
  sameInstruction,
  toHex,
  type AsmInstruction,
  type Operand,
} from './backend';

const encoder = getEncoder('e2k');
const reg = (index: number): Operand => ({ kind: 'reg', index });
const wreg = (index: number): Operand => ({ kind: 'reg', index, file: 'window' });
const imm = (value: number): Operand => ({ kind: 'imm', value });
/** 64-битный литерал: отдельный вид операнда, значение — `bigint` (в `number` не представимо). */
const f64 = (value: bigint): Operand => ({ kind: 'imm64', value }) as unknown as Operand;
const asm = (mnemonic: string, operands: readonly Operand[]): AsmInstruction => ({
  mnemonic,
  channel: 0,
  operands,
});

/** Байты литерала, начиная со слова 2 (8 байт после заголовочного слога и слога ALS). */
function literalBytes(instruction: AsmInstruction): string {
  return toHex(encoder.encode(instruction)).split(' ').slice(8).join(' ');
}

describe('форма 0xdc: 64-битный литерал', () => {
  it('1.1 movtd,0 _f64 0x100000, %r8 — измеренные байты', () => {
    const instruction = asm('movtd', [f64(0x100000n), wreg(8)]);
    expect(toHex(encoder.encode(instruction))).toBe('11 00 00 04 88 dc c0 61 00 00 00 00 00 00 10 00');
    // Длина — 16 байт: заголовок + слог ALS + ДВА слова литерала.
    expect(encoder.encode(instruction).length).toBe(16);
    // Поле ссылки на литерал — 0xdc, приёмник — оконный %r8 (0x80 | 8 = 0x88).
    const bytes = encoder.encode(instruction);
    expect(bytes[5], 'поле src2').toBe(0xdc);
    expect(bytes[4], 'поле dst').toBe(0x88);
    expect(bytes[7], 'код операции movtd').toBe(0x61);
  });

  it('1.2 порядок байт: 0xdeadbeefcafebabe', () => {
    const instruction = asm('movtd', [f64(0xdeadbeefcafebaben), wreg(8)]);
    expect(literalBytes(instruction)).toBe('ef be ad de be ba fe ca');
    // Обратный разбор обязан вернуть то же значение: иначе порядок слов не проверен.
    const back = encoder.decode(encoder.encode(instruction));
    expect(back.operands[0]).toEqual(f64(0xdeadbeefcafebaben));
    expect(sameInstruction(back, instruction), 'круг по форме 0xdc').toBe(true);
  });

  it('1.3 movts,0 0x100000000 — ОТКАЗ, а не молчаливый ноль', () => {
    // Короткая форма несёт 16- или 32-битный литерал; 2³² в неё не влезает. Молчаливое усечение
    // дало бы рабочую на вид инструкцию с неправильным значением.
    expect(() => encoder.encode(asm('movts', [imm(0x100000000), reg(1)]))).toThrow(EncodingRefusedError);
    expect(() => encoder.encode(asm('movts', [imm(0x100000000), reg(1)]))).toThrow(/32 бита|64-битн/);
    // И граница названа: 32-битный максимум ещё кодируется.
    expect(() => encoder.encode(asm('movts', [imm(2147483647), reg(1)]))).not.toThrow();
  });

  it('1.4 литерал больше 64 бит — ОТКАЗ', () => {
    expect(() => encoder.encode(asm('movtd', [f64(1n << 64n), wreg(8)]))).toThrow(EncodingRefusedError);
    expect(() => encoder.encode(asm('movtd', [f64(1n << 64n), wreg(8)]))).toThrow(/64/);
    // Границы формы: наибольшее и наименьшее 64-битное значение кодируются.
    for (const edge of [0n, (1n << 64n) - 1n]) {
      expect(() => encoder.encode(asm('movtd', [f64(edge), wreg(8)])), `${edge}`).not.toThrow();
    }
  });

  it('форма выбирается видом операнда, а не величиной значения', () => {
    // 0x100000 влезает в 32 бита — и всё равно кодируется 64-битной формой, если операнд imm64:
    // иначе адрес потерялся бы на короткой форме.
    const wide = encoder.encode(asm('movtd', [f64(0x100000n), wreg(8)]));
    const narrow = encoder.encode(asm('movts', [imm(0x100000), reg(8)]));
    expect(wide.length).toBe(16);
    expect(narrow.length, 'короткая форма остаётся короткой').toBe(16);
    expect(wide[5], 'широкая форма — поле 0xdc').toBe(0xdc);
    expect(narrow[5], 'короткая форма — поле 0xd8 (32 бита)').toBe(0xd8);
  });

  it('НЕГАТИВНЫЙ КОНТРОЛЬ: подмена порядка слов ловится кругом', () => {
    const instruction = asm('movtd', [f64(0xdeadbeefcafebaben), wreg(8)]);
    const bytes = Uint8Array.from(encoder.encode(instruction));
    // Меняем два слова литерала местами: значение обязано стать другим, и разбор это покажет.
    const swapped = Uint8Array.from(bytes);
    for (let at = 0; at < 4; at++) {
      swapped[8 + at] = bytes[12 + at]!;
      swapped[12 + at] = bytes[8 + at]!;
    }
    const back = encoder.decode(swapped);
    expect(back.operands[0], 'перестановка слов не изменила значение').not.toEqual(f64(0xdeadbeefcafebaben));
    expect(back.operands[0]).toEqual(f64(0xcafebabedeadbeefn));
  });
});
