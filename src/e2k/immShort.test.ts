/**
 * ОРАКУЛ КОРОТКОЙ НЕПОСРЕДСТВЕННОЙ ФОРМЫ (`0xc0 | N`).
 *
 * # Что это и почему
 *
 * Значение 0…15 ассемблер МЦСТ кладёт **4-битной непосредственной формой** в слоте литерала —
 * 8 байт. Наш кодировщик писал такое значение **литералом LTS** (`0xd4`) — 16 байт. Расхождение
 * измерено: `docs/e2k-minimal-elf.md:118-123` (текст `movts,0 1, %r8`: ассемблер `01 00 00 04 88 c1
 * c0 60`, наш `11 00 00 04 88 d4 c0 60 … 01 00`).
 *
 * # Точная форма снята живым ассемблером
 *
 * Канал сверки — `src/scripts/e2kExternalAs.ts` (тот же, что принял 24 образца из 24). Серия
 * значений 0…16 дала:
 *
 * ```
 * N = 0…15: 01 00 00 04 01 c(N) c0 60   — 8 байт, где c(N) = 0xc0 | N, и lng = 0
 * N = 16:   11 00 00 04 01 d4 c0 60 00 … — 16 байт, литерал LTS, то есть форма нашего кодировщика
 * ```
 *
 * # Границы
 *
 * `lng = 0` в HS (первый байт `01` вместо `11`) — это и есть «короткая форма»: одно слово ALS.
 * Форма применима **только** к коротким формам ALF1/ALF2: у длинной (ALF11) слог литерала
 * конкурирует за место с полуслогом ALES и отвергается кодировщиком
 * (`src/e2k/e2k-real.ts:1263-1268`).
 */

import { describe, it, expect } from 'vitest';
import { getEncoder, type AsmInstruction } from './backend';
import { assembleAll, findExternalAs, type AsSample } from '../scripts/e2kExternalAs';

const encoder = getEncoder('e2k');

/** `movts` с непосредственным операндом: ALF2, слот литерала — `src2`. */
const movtsImm = (value: number, destination = 1): AsmInstruction => ({
  mnemonic: 'movts',
  channel: 0,
  operands: [
    { kind: 'imm', value },
    { kind: 'reg', index: destination },
  ],
});

const hex = (bytes: Uint8Array): string =>
  Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join(' ');

/** Слово по смещению (младшим байтом вперёд). */
const word = (bytes: Uint8Array, offset: number): number =>
  (bytes[offset]! | (bytes[offset + 1]! << 8) | (bytes[offset + 2]! << 16) | (bytes[offset + 3]! << 24)) >>> 0;

/** Байт поля ссылки на литерал (второе слово, байт 1 — там, где у LTS стоит `0xd4`). */
const literalField = (bytes: Uint8Array): number => (word(bytes, 4) >>> 8) & 0xff;

/** Полуслово по смещению: 16-битный литерал лежит именно полусловом, а не словом. */
const half = (bytes: Uint8Array, offset: number): number => (bytes[offset]! | (bytes[offset + 1]! << 8)) & 0xffff;

describe('короткая непосредственная форма: структура', () => {
  it('1.1 значение 5 кодируется короткой формой: 8 байт и поле 0xc0|5', () => {
    const bytes = encoder.encode(movtsImm(5));
    expect(bytes.length, 'длина').toBe(8);
    expect(literalField(bytes), 'поле слота литерала').toBe(0xc0 | 5);
    // HS: lng = 0 (короткая форма), mdl = 1, канал 0 в бите al.
    expect(word(bytes, 0) & 0xff, 'первый байт HS').toBe(0x01);
    expect((word(bytes, 0) >>> 4) & 0x7, 'lng').toBe(0);
    expect((word(bytes, 0) >>> 26) & 0x3f, 'бит канала ALS').toBe(1);
  });

  it('1.2 значение 15 — та же форма, поле 0xcf', () => {
    const bytes = encoder.encode(movtsImm(15));
    expect(bytes.length, 'длина').toBe(8);
    expect(literalField(bytes), 'поле').toBe(0xcf);
  });

  it('1.3 значение 16 — отказ от короткой формы: литерал, 16 байт', () => {
    const bytes = encoder.encode(movtsImm(16));
    expect(bytes.length, 'длина').toBe(16);
    // 16 остаётся **16-битным** литералом (`0xd4`): короткая форма — это 0…15, а не «0…15 плюс ещё».
    // Так же поступает ассемблер МЦСТ: для 16 он даёт `01 d4` (измерено в этом же сеансе).
    expect(literalField(bytes), 'поле литерала').toBe(0xd4);
    // И значение действительно лежит в слове литерала — это не «короткая форма с усечением».
    // 16-битный литерал пишется **полусловом** по смещению 14 (`writeHalf`), а не словом по 12.
    expect(half(bytes, 14), 'полуслово литерала').toBe(16);
  });

  it('1.4 граница проверена на обе стороны: 15 короткая, 16 длинная', () => {
    expect(encoder.encode(movtsImm(15)).length, '15').toBe(8);
    expect(encoder.encode(movtsImm(16)).length, '16').toBe(16);
    for (let value = 0; value <= 15; value++) {
      expect(literalField(encoder.encode(movtsImm(value))), `N = ${value}`).toBe(0xc0 | value);
    }
  });

  it('1.5 адресат не влияет на поле, но виден в слове ALS', () => {
    // Форма ALF2: dst[7:0], src2[15:8], opce[23:16]. Слот литерала — src2.
    const bytes = encoder.encode(movtsImm(3, 9));
    expect(literalField(bytes), 'поле').toBe(0xc3);
    // Регистр 9 в базовом файле — младший байт слова ALS.
    expect(word(bytes, 4) & 0xff, 'адресат').toBe(9);
  });

  it('1.6 округ до 15 включительно не трогает отрицательные и большие значения', () => {
    // Отрицательные и 16+ идут литералом: короткая форма только для 0…15.
    expect(encoder.encode(movtsImm(-1)).length, 'минус один').toBe(16);
    expect(encoder.encode(movtsImm(32767)).length, '32767').toBe(16);
  });

  /**
   * Разбор обязан ПРИНИМАТЬ короткую форму.
   *
   * Повод: поле `0xc0|N` — непосредственное значение, а не регистр. Проверка
   * «регистр выражается полем слога» стояла до разбора операндов и падала на
   * `0xc1`: «регистр 193 не выражается полем слога (0..63)». Из-за этого
   * сквозной прогон ядер (`e2kRealRun`) падал целиком на первом же `movts` с
   * маленьким литералом вместо того, чтобы назвать причину.
   */
  it('1.7 разбор читает короткую форму как непосредственное значение, а не как регистр', () => {
    for (const [value, destination] of [
      [0, 2],
      [1, 12],
      [15, 9],
    ] as const) {
      const bytes = encoder.encode(movtsImm(value, destination));
      expect(bytes.length, `N = ${value}: короткая форма`).toBe(8);
      const back = encoder.decode(bytes);
      expect(back.mnemonic, `N = ${value}`).toBe('movts');
      expect(back.operands[0], `N = ${value}: первый операнд — непосредственное`).toEqual({
        kind: 'imm',
        value,
      });
      expect(back.operands[1], `N = ${value}: адресат`).toEqual({ kind: 'reg', index: destination });
    }
  });
});

describe('короткая непосредственная форма: сверка с ассемблером МЦСТ', () => {
  const tool = findExternalAs();

  /** Образец для живой сверки: ассемблерный текст и наша инструкция. */
  const sample = (value: number): AsSample => ({
    key: `movts_${value}`,
    mnemonic: 'movts',
    channel: 0,
    form: 'ALF2 + immediate',
    asText: `movts,0 ${value}, %b[1]`,
    instruction: movtsImm(value, 1),
    source: 'короткая непосредственная форма: серия 0…16',
  });

  const VALUES: readonly number[] = [0, 1, 5, 10, 15, 16];

  it('1.7 байты совпадают с ассемблером МЦСТ побайтово — или причина названа', () => {
    if (tool.tool === undefined) {
      // Слабый режим назван, а не выдан за «пройдено»: без ассемблера сверки нет.
      expect(tool.reason, 'причина отсутствия ассемблера').toBeTruthy();
      return;
    }
    const samples = VALUES.map(sample);
    const results = assembleAll(samples);
    expect(results.length, 'собрано образцов').toBe(VALUES.length);
    const problems: string[] = [];
    results.forEach((result, index) => {
      const value = VALUES[index]!;
      if (!result.ok) {
        problems.push(`N = ${value}: ассемблер не собрал — ${result.error}`);
        return;
      }
      const ours = hex(encoder.encode(samples[index]!.instruction));
      const theirs = hex(result.bytes);
      if (ours !== theirs) problems.push(`N = ${value}: наш «${ours}», ассемблер «${theirs}»`);
    });
    expect(problems, 'расхождения с ассемблером').toEqual([]);
  });

  it('1.8 форма разобрана: те же 8 байт, что в документе', () => {
    // Число из `docs/e2k-minimal-elf.md:116` — измерено ранее и **независимо**: текст
    // `movts,0 1, %r8`. Адресат здесь оконный (`%r8`), признак файла даёт байт `0x88`, а не `0x08`.
    const windowMovts: AsmInstruction = {
      mnemonic: 'movts',
      channel: 0,
      operands: [
        { kind: 'imm', value: 1 },
        { kind: 'reg', index: 8, file: 'window' },
      ],
    };
    expect(hex(encoder.encode(windowMovts)), 'N = 1, %r8').toBe('01 00 00 04 88 c1 c0 60');
  });
});

describe('оракул собран и проверяет непустое множество', () => {
  it('кодировщик отвечает и даёт два разных размера', () => {
    const sizes = new Set([0, 7, 15, 16].map((value) => encoder.encode(movtsImm(value)).length));
    expect([...sizes].sort((a, b) => a - b), 'встреченные размеры').toEqual([8, 16]);
  });
});
