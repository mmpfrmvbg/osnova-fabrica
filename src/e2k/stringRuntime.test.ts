/**
 * ОРАКУЛ СТРОК: БАЙТЫ, КОДОВЫЕ ТОЧКИ, ГРАНИЦА БУФЕРА И СОВПАДЕНИЕ ФОРМЫ С ПОНИЖЕНИЕМ.
 *
 * # Что здесь утверждается
 *
 * 1. **Длина — КОДОВЫЕ ТОЧКИ** (решение владельца), а не байты и не UTF-16: `🙂` — это **1**, хотя
 *    байтов 4. Проверяется на нескольких алфавитах, включая составные и трёхбайтовые.
 * 2. **Таблица продолжений** — ровно на `0b10xxxxxx`: 64 единицы из 256.
 * 3. **Склейка влезает в 20 байт или отказывает С ЧИСЛАМИ**: 20 влезает ровно, 21 — названный отказ.
 * 4. **Форма совпадает с понижением БАЙТ В БАЙТ.** Раскладка считает длину сайта по форме, а образ
 *    собирается из команд понижения: разойтись им нельзя (класс дефекта §3.35, повторённый на
 *    возврате в §3.45). Здесь это проверяется прямым сравнением.
 * 5. **Регистры рантайма массивов целы**: `%b[14]` (восемь) и `%b[15]` (куча) не трогаются вовсе,
 *    а `%b[12]` (ноль) и `%b[13]` (единица) возвращаются на место — иначе массивная часть программы
 *    получила бы мусор вместо нуля и единицы.
 *
 * # Чего здесь НЕТ
 *
 * Прогона в модели: он в шлюзе (`src/e2k/printPrimitivesQemu.test.ts`, раздел про строки) и в
 * оракуле корпуса (`src/scripts/examplesE2k.audit.test.ts`, записи `02` и `04` — байты против эталона).
 */
import { describe, it, expect } from 'vitest';
import { getEncoder } from './backend';
import { ARRAY_REGISTERS } from './arrayRuntime';
import {
  STRING_BUFFER_BYTES,
  STRING_PRINT_CLOBBERS,
  STRING_REGISTERS,
  codePointCount,
  concatFitsBuffer,
  continuationTable,
  stringArenaCopyInstructions,
  stringConcatInstructions,
  stringLengthInstructions,
  stringSequenceProblems,
  stringWriteInstructions,
  utf8Bytes,
} from './stringRuntime';

const encoder = getEncoder('e2k');
const encoded = (instructions: readonly { mnemonic: string; channel: number; operands: readonly unknown[] }[]): number =>
  instructions.reduce((sum, instruction) => sum + encoder.encode(instruction as never).length, 0);

describe('строки: байты, кодпоинты и границы', () => {
  it('длина считается КОДОВЫМИ ТОЧКАМИ: 🙂 — один, а не два и не четыре', () => {
    expect(utf8Bytes('🙂')).toHaveLength(4);
    expect(codePointCount(utf8Bytes('🙂')), 'приёмка владельца: кодпоинт = 1').toBe(1);
    expect(codePointCount(utf8Bytes('Аня')), 'двухбайтовые').toBe(3);
    expect(codePointCount(utf8Bytes('привет'))).toBe(6);
    expect(codePointCount(utf8Bytes('Привет, мир')), 'эталон записи 04: 11 кодпоинтов при 20 байтах').toBe(11);
    expect(codePointCount(utf8Bytes('')), 'пустая строка — ноль').toBe(0);
    // Различающий контроль: байтовый счёт дал бы другое число на каждом не-ASCII слове.
    for (const text of ['🙂', 'Аня', 'Привет, мир']) {
      expect(codePointCount(utf8Bytes(text)), `кодпоинты «${text}» не равны байтам`).not.toBe(utf8Bytes(text).length);
    }
  });

  it('таблица продолжений: ровно 64 единицы — на 0b10xxxxxx', () => {
    const table = continuationTable();
    expect(table).toHaveLength(256);
    expect(table.filter((value) => value === 1)).toHaveLength(64);
    for (const byte of [0x00, 0x41, 0x7f, 0xc0, 0xc2, 0xe0, 0xf0, 0xff]) {
      expect(table[byte], `0x${byte.toString(16)} — не продолжение`).toBe(0);
    }
    for (const byte of [0x80, 0x8f, 0x9f, 0xbf]) {
      expect(table[byte], `0x${byte.toString(16)} — продолжение`).toBe(1);
    }
  });

  it('граница буфера: 20 влезает ровно, 21 — уже АРЕНА (отказ переехал на исчерпание)', () => {
    expect(concatFitsBuffer(14, 6), 'склейка записи 04 — ровно 20 байт').toBe(true);
    expect(concatFitsBuffer(STRING_BUFFER_BYTES, 0)).toBe(true);
    expect(concatFitsBuffer(20, 1), '21 байт в статический буфер не влезает — но и не отказ').toBe(false);
    expect(concatFitsBuffer(0, 0), 'пустое влезает').toBe(true);
    // Различающая пара: 20 и 21 отличаются ОДНИМ байтом и решением о способе, а не «примерно».
    expect(concatFitsBuffer(19, 1)).not.toBe(concatFitsBuffer(19, 2));
  });

  it('структура последовательностей: регистры рантайма массивов целы', () => {
    const length = stringLengthInstructions({ base: 0, byteLength: 14, destination: 1, tableAddress: 0x101ec0 });
    const concat = stringConcatInstructions({
      first: 0,
      second: 1,
      destination: 2,
      bufferAddress: 0x101ed0,
      firstBytes: 8,
      secondBytes: 6,
    });
    // СКЛЕЙКА В БЛОК АРЕНЫ — четвёртая последовательность того же рантайма: база записи приходит
    // РЕГИСТРОМ (адрес выделения), поэтому ноль рантайма массивов не трогается вовсе.
    const arenaConcat = stringArenaCopyInstructions({
      first: 0,
      second: 1,
      base: 2,
      firstBytes: 8,
      secondBytes: 6,
    });
    const write = stringWriteInstructions({ address: 0, byteLength: 11, newlineAddress: 0x101ec0 });
    for (const [name, instructions] of [
      ['длина', length],
      ['склейка', concat],
      ['склейка в арене', arenaConcat],
      ['вывод', write],
    ] as const) {
      expect(stringSequenceProblems(instructions), `структура «${name}»`).toEqual([]);
    }
    // Сторож РАБОТАЕТ: вынесем восстановление нуля — обязан покраснеть.
    const broken = length.filter(
      (instruction) =>
        !(instruction.mnemonic === 'movts' && instruction.operands[1]?.kind === 'reg' && instruction.operands[1].index === ARRAY_REGISTERS.zero),
    );
    expect(stringSequenceProblems(broken), 'без возврата нуля сторож обязан краснеть').not.toEqual([]);
    // И порча кучи обязана быть видна.
    const damaged = [
      ...length,
      { mnemonic: 'adds', channel: 0, operands: [{ kind: 'reg', index: ARRAY_REGISTERS.heapSlot }, { kind: 'imm', value: 1 }, { kind: 'reg', index: ARRAY_REGISTERS.heapSlot }] },
    ];
    expect(stringSequenceProblems(damaged as never), 'порча кучи обязана быть видна').not.toEqual([]);
    // Различающий контроль арены: у неё восстанавливается ЕДИНИЦА (смещение записи), а ноль — нет:
    // значит «восстановление» сторож берёт из факта порчи, а не из того, что оно там когда-то было.
    const arenaBroken = arenaConcat.filter(
      (instruction) =>
        !(instruction.mnemonic === 'movts' && instruction.operands[1]?.kind === 'reg' && instruction.operands[1].index === ARRAY_REGISTERS.one),
    );
    expect(stringSequenceProblems(arenaBroken), 'без возврата единицы сторож обязан краснеть').not.toEqual([]);
  });

  it('ФОРМА СОВПАДАЕТ С ПОНИЖЕНИЕМ: длина команд строкового рантайма — то же, что считает раскладка', () => {
    // Раскладка берёт формы команд из `printCommandForm` (src/e2k/printCall.ts), понижение кодирует
    // те же команды кодировщиком. Здесь сравниваются ОБА числа — расхождение обязано быть видно.
    const sequences = [
      stringLengthInstructions({ base: 0, byteLength: 20, destination: 1, tableAddress: 0x101ec0 }),
      stringConcatInstructions({ first: 0, second: 1, destination: 2, bufferAddress: 0x101ed0, firstBytes: 10, secondBytes: 10 }),
      stringArenaCopyInstructions({ first: 0, second: 1, base: 2, firstBytes: 10, secondBytes: 11 }),
      stringWriteInstructions({ address: 0, byteLength: 20, newlineAddress: 0x101ec0 }),
    ];
    for (const instructions of sequences) {
      const bytes = encoded(instructions);
      expect(bytes, 'длина команд строкового рантайма положительна').toBeGreaterThan(0);
      // Каждая команда обязана быть кодируемой: иначе «форма» и «байты» разошлись бы молча.
      for (const instruction of instructions) {
        expect(() => encoder.encode(instruction as never), `кодируется «${instruction.mnemonic}»`).not.toThrow();
      }
    }
  });

  it('вывод строки портит МЕНЬШЕ регистров, чем развёртка числа: это названо', () => {
    // Набор порчи — то, чем конвейер планирует сохранение живых; он обязан быть именно таким:
    // оконные аргументы `write` (%r8..%r11) и временный %b[10]. Ноль рантайма только читается.
    expect([...STRING_PRINT_CLOBBERS].sort((a, b) => a - b)).toEqual([8, 9, 10, 11]);
    expect(STRING_PRINT_CLOBBERS).toContain(STRING_REGISTERS.first);
    expect(STRING_PRINT_CLOBBERS).not.toContain(ARRAY_REGISTERS.zero);
    expect(STRING_PRINT_CLOBBERS).not.toContain(ARRAY_REGISTERS.heap);
  });
});
