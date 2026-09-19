/**
 * ОРАКУЛ ФОРМЫ ПАМЯТИ e2k (`ld*`/`st*`).
 *
 * # Зачем
 *
 * Массивы в регистровом IR — это хост-вызовы `система.массив.*` (`IR.invoke`): создание, длина,
 * чтение элемента, добавление. Пока они не заменены **реальными** обращениями к памяти, ядро FIR
 * целиком не собирается: 24 носителя из 111 не понижаются (`docs/e2k-wide-commands.md` §5.4).
 * Первый шаг — форма памяти, и она проверяется здесь, ДО реализации.
 *
 * # Что измерено и откуда известно (источники)
 *
 * | утверждение | источник |
 * |---|---|
 * | адрес `ld`/`st` — **сумма двух регистров** `src1 + src2` | `qemu/target/e2k/tcg/translate-al-c11.c:26-34` (`calc_addr_LD_ST`), `:65-95` (`prep_LD`/`prep_ST`) |
 * | раскладка ALF3: `src3[7:0]`, `src2[15:8]`, `src1[23:16]` | `qemu/target/e2k/syllab-format.h:47-49` |
 * | раскладка ALF1: `dst[7:0]`, `src2[15:8]`, `src1[23:16]` | `qemu/target/e2k/syllab-format.h:39-41` |
 * | `ldb/ldh/ldw/ldd` — ALOPF1, opc `0x64…0x67`, каналы `{1,0,1,1,0,1}` | `opcodes/e2k-opc.h:604-619` |
 * | `stb/sth/stw/std` — ALOPF3, opc `0x24…0x27`, каналы `{0,0,1,0,0,1}` | `opcodes/e2k-opc.h:969-984` |
 * | текст `st*` у ассемблера идёт в порядке **(значение, база, смещение)** = `(src3, src1, src2)` | измерено (`as-new -mcpu=elbrus-v5`): `.tmp/std-order.ts` |
 * | текст `ld*` — в порядке **(src1, src2, приёмник)** | измерено там же |
 * | байты `ldd,0 %b[1], %b[2], %db[3]` → `01 00 00 04 03 02 01 67` | измерено; совпало с разбором `objdump` МЦСТ |
 * | запрещённый канал — отказ: `` `std' cannot be encoded in ALC0 `` | измерено (текст ошибки ассемблера) |
 *
 * # Чего оракул НЕ доказывает
 *
 * Что память **работает** в модели: байты и разбор доказывают форму, а не исполнение. Исполнение
 * проверяется отдельно — `src/e2k/e2kMemoryQemu.test.ts` (шлюз `gate:qemu`).
 */

import { describe, it, expect } from 'vitest';
import { getEncoder, type AsmInstruction, type Operand } from './backend';
import { realOpcode } from './e2k-real';
import { assembleAll, findExternalAs, type AsSample } from '../scripts/e2kExternalAs';

const encoder = getEncoder('e2k');

const reg = (index: number): Operand => ({ kind: 'reg', index });

/** Байты → hex. */
const hexOf = (bytes: Uint8Array): string =>
  Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join(' ');

/**
 * Загрузка: `ldd,<канал> <база>, <смещение>, <приёмник>` — порядок совпадает с текстом ассемблера.
 */
const load = (base: number, offset: number, dst: number, mnemonic = 'ldd', channel = 0): AsmInstruction => ({
  mnemonic,
  channel,
  operands: [reg(base), reg(offset), reg(dst)],
});

/**
 * Запись: у ассемблера текст идёт **(значение, база, смещение)** — измерено, поэтому в нашей
 * таблице слоты ровно в этом порядке, и интерфейс повторяет текст, а не придумывает свой.
 */
const store = (value: number, base: number, offset: number, mnemonic = 'std', channel = 2): AsmInstruction => ({
  mnemonic,
  channel,
  operands: [reg(value), reg(base), reg(offset)],
});

describe('память e2k: таблица опкодов', () => {
  it('ld* и st* есть в таблице с измеренными opc, формой и каналами', () => {
    const expected: ReadonlyArray<{ mnemonic: string; opc: number; form: string; channels: number[] }> = [
      { mnemonic: 'ldb', opc: 0x64, form: 'ALF1', channels: [0, 2, 3, 5] },
      { mnemonic: 'ldh', opc: 0x65, form: 'ALF1', channels: [0, 2, 3, 5] },
      { mnemonic: 'ldw', opc: 0x66, form: 'ALF1', channels: [0, 2, 3, 5] },
      { mnemonic: 'ldd', opc: 0x67, form: 'ALF1', channels: [0, 2, 3, 5] },
      { mnemonic: 'stb', opc: 0x24, form: 'ALF3', channels: [2, 5] },
      { mnemonic: 'sth', opc: 0x25, form: 'ALF3', channels: [2, 5] },
      { mnemonic: 'stw', opc: 0x26, form: 'ALF3', channels: [2, 5] },
      { mnemonic: 'std', opc: 0x27, form: 'ALF3', channels: [2, 5] },
    ];
    const problems: string[] = [];
    for (const item of expected) {
      const entry = realOpcode(item.mnemonic);
      if (entry === undefined) {
        problems.push(`${item.mnemonic}: нет в таблице`);
        continue;
      }
      if (entry.opc !== item.opc) problems.push(`${item.mnemonic}: opc 0x${entry.opc.toString(16)}, ждали 0x${item.opc.toString(16)}`);
      if (entry.form !== item.form) problems.push(`${item.mnemonic}: форма ${entry.form}, ждали ${item.form}`);
      if ([...entry.channels].sort((a, b) => a - b).join(',') !== item.channels.join(',')) {
        problems.push(`${item.mnemonic}: каналы ${entry.channels.join(',')}, ждали ${item.channels.join(',')}`);
      }
    }
    expect(problems, problems.join('; ')).toEqual([]);
  });
});

describe('память e2k: байты', () => {
  it('ldd и std кодируются измеренными байтами', () => {
    // Измерено ассемблером МЦСТ: `ldd,0 %b[1], %b[2], %db[3]` → 01 00 00 04 03 02 01 67.
    expect(hexOf(encoder.encode(load(1, 2, 3)))).toBe('01 00 00 04 03 02 01 67');
    // `std,2 %b[3], %b[1], %b[2]` (значение, база, смещение) → 01 00 00 10 03 02 01 27.
    expect(hexOf(encoder.encode(store(3, 1, 2)))).toBe('01 00 00 10 03 02 01 27');
  });

  it('слог ALS памяти читается обратно нашим разбором', () => {
    const back = encoder.decode(encoder.encode(load(1, 2, 3)));
    expect(back.mnemonic).toBe('ldd');
    expect(back.operands).toEqual([reg(1), reg(2), reg(3)]);
    const backStore = encoder.decode(encoder.encode(store(3, 1, 2)));
    expect(backStore.mnemonic).toBe('std');
    expect(backStore.operands).toEqual([reg(3), reg(1), reg(2)]);
  });

  it('канал выражен в HS: у st* он ограничен каналами 2 и 5', () => {
    // `std` в канале 2: HS = 01 00 00 10 (бит 26+2). Замерено.
    expect(hexOf(encoder.encode(store(3, 1, 2, 'std', 2))).slice(0, 11)).toBe('01 00 00 10');
    // Канал 0 для `std` ассемблер отвергает — и наш кодировщик обязан отказать, а не выдать байты.
    expect(() => encoder.encode(store(3, 1, 2, 'std', 0))).toThrow();
  });

  it('байты совпадают с ассемблером МЦСТ побайтово — или причина названа', () => {
    const cases: ReadonlyArray<{ asText: string; instruction: AsmInstruction }> = [
      { asText: 'ldd,0 %b[1], %b[2], %db[3]', instruction: load(1, 2, 3) },
      { asText: 'ldd,0 %b[7], %b[4], %db[2]', instruction: load(7, 4, 2) },
      { asText: 'ldd,3 %b[5], %b[6], %db[1]', instruction: load(5, 6, 1, 'ldd', 3) },
      { asText: 'ldw,0 %b[1], %b[2], %b[3]', instruction: load(1, 2, 3, 'ldw') },
      { asText: 'std,2 %b[3], %b[1], %b[2]', instruction: store(3, 1, 2) },
      { asText: 'std,5 %b[1], %b[2], %b[3]', instruction: store(1, 2, 3, 'std', 5) },
      { asText: 'stw,2 %b[3], %b[1], %b[2]', instruction: store(3, 1, 2, 'stw') },
    ];
    const { tool, reason } = findExternalAs();
    if (tool === undefined) {
      expect(reason, 'причина недоступности ассемблера не названа').toBeDefined();
      return;
    }
    const samples: AsSample[] = cases.map((item, index) => ({
      key: item.asText,
      mnemonic: item.instruction.mnemonic,
      channel: item.instruction.channel,
      form: 'mem',
      asText: item.asText,
      instruction: item.instruction,
      source: 'src/e2k/e2kMemory.test.ts',
    }));
    const results = assembleAll(samples);
    const problems: string[] = [];
    cases.forEach((item, index) => {
      const result = results[index]!;
      const ours = hexOf(encoder.encode(item.instruction));
      if (!result.ok) {
        problems.push(`«${item.asText}»: ассемблер отказал — ${result.error}`);
        return;
      }
      const theirs = hexOf(result.bytes);
      if (ours !== theirs) problems.push(`«${item.asText}»: наши ${ours}, ассемблер ${theirs}`);
    });
    expect(problems, problems.join('; ')).toEqual([]);
  });

  it('негативный контроль: чужой канал и чужая база ловятся кодировщиком', () => {
    // Операнд-литерал там, где обязан быть регистр, — отказ с причиной.
    expect(() =>
      encoder.encode({ mnemonic: 'ldd', channel: 0, operands: [{ kind: 'imm', value: 1 }, reg(2), reg(3)] }),
    ).toThrow();
    // Неизвестной мнемоники памяти нет — отказ, а не молчаливые байты.
    expect(() => encoder.encode({ mnemonic: 'ldq', channel: 0, operands: [reg(1), reg(2), reg(3)] })).toThrow();
  });
});
