/**
 * ОРАКУЛ ФОРМ ДЕЛЕНИЯ И ОСТАТКА — ЦЕЛОЧИСЛЕННЫХ (`UDIVx`, `SDIVx`, `UMODx`, `SMODx`, `SDIVs/d`, `UDIVs/d`).
 *
 * # Откуда формы
 *
 * `opcodes/e2k-opc.h` (binutils МЦСТ, ветка `binutils-mcst-2.41`), раздел операций ALOPF1:
 *
 * | строка | мнемоника | код | аргументы (МЦСТ) | каналы (МЦСТ) |
 * |---|---|---|---|---|
 * | :39 | `udivx` | 0x44 | `ARGS_DSS` | `{0,0,0,0,0,1}` |
 * | :44 | `umodx` | 0x45 | `ARGS_DSS` | `{0,0,0,0,0,1}` |
 * | :49 | `sdivx` | 0x46 | `ARGS_DSS` | `{0,0,0,0,0,1}` |
 * | :54 | `smodx` | 0x47 | `ARGS_DSS` | `{0,0,0,0,0,1}` |
 * | :59 | `udivs` | 0x40 | `ARGS_SSS` | `{0,0,0,0,0,1}` |
 * | :64 | `udivd` | 0x41 | `ARGS_DDD` | `{0,0,0,0,0,1}` |
 * | :69 | `sdivs` | 0x42 | `ARGS_SSS` | `{0,0,0,0,0,1}` |
 * | :74 | `sdivd` | 0x43 | `ARGS_DDD` | `{0,0,0,0,0,1}` |
 *
 * Каналы — **только пятый**: `{0,0,0,0,0,1}` против `{1,1,1,1,1,1}` у `adds` (`:19`). В языке ассемблера
 * канал пишется прямо: руководство МЦСТ (§10.3.3, пример) даёт `sdivs,5 %g17, %g16, %g16`.
 *
 * Семантика (руководство МЦСТ, §10.3.3): `SDIVs/d` — деление целых со знаком 32/32→32 или 64/64→64,
 * нецелые частные округляются отсечением, `exc_div` при делителе 0; `UDIVs/d` — без знака;
 * `SDIVX`/`UDIVX`/`SMODX`/`UMODX` — **64/32→32** (расширенное делимое), остаток имеет знак делимого.
 *
 * # Что проверяется
 *
 * | # | проверка |
 * |---|---|
 * | 1 | каждая из восьми форм есть в таблице с кодом, форматом и каналами ИЗ ИСТОЧНИКА |
 * | 2 | байты нашего кодировщика равны байтам, которые дал **ассемблер МЦСТ** (замер `.tmp/div-forms.ts`) |
 * | 3 | канал, кроме пятого, — отказ с причиной (форма в нём не существует) |
 * | 4 | операция не собирается с чужой разрядностью (`sdivs` требует `S`-операнды) |
 *
 * # Чего оракул НЕ доказывает
 *
 * Что эти формы **исполняются** моделью: прогона нет (в модели нет ни одной из них — они не были
 * извлечены). И что они подходят нашему `IR.div`: семантика IR — **точное** деление (`a / b` в
 * `src/runtime/vm/reginterpreter.ts:321`), а `SDIVs` **отсекает** дробную часть; это расхождение
 * названо в `docs/e2k-real-run.md`, а не спрятано.
 */

import { describe, it, expect } from 'vitest';
import { EncodingRefusedError, getEncoder, type AsmInstruction, type Operand } from './backend';
import { REAL_OPCODES, realOpcode } from './e2k-real';
import { assembleAll, findExternalAs, type AsSample } from '../scripts/e2kExternalAs';

const encoder = getEncoder('e2k');
const reg = (index: number): Operand => ({ kind: 'reg', index });
const dreg = (index: number): Operand => ({ kind: 'reg', index, quadro: true }) as unknown as Operand;

/** Формы деления и остатка: код, разрядность операндов и каналы — ИЗ ТАБЛИЦЫ МЦСТ. */
const FORMS: ReadonlyArray<{
  mnemonic: string;
  opc: number;
  formats: readonly ('S' | 'D')[];
  source: string;
  manual: string;
  asText: string;
}> = [
  { mnemonic: 'udivs', opc: 0x40, formats: ['S', 'S', 'S'], source: 'opcodes/e2k-opc.h:59', manual: 'UDIVs — деление без знака 32/32→32', asText: 'udivs,5 %b[2], %b[3], %b[4]' },
  { mnemonic: 'udivd', opc: 0x41, formats: ['D', 'D', 'D'], source: 'opcodes/e2k-opc.h:64', manual: 'UDIVd — деление без знака 64/64→64', asText: 'udivd,5 %db[2], %db[3], %db[4]' },
  { mnemonic: 'sdivs', opc: 0x42, formats: ['S', 'S', 'S'], source: 'opcodes/e2k-opc.h:69', manual: 'SDIVs — деление со знаком 32/32→32', asText: 'sdivs,5 %b[2], %b[3], %b[4]' },
  { mnemonic: 'sdivd', opc: 0x43, formats: ['D', 'D', 'D'], source: 'opcodes/e2k-opc.h:74', manual: 'SDIVd — деление со знаком 64/64→64', asText: 'sdivd,5 %db[2], %db[3], %db[4]' },
  { mnemonic: 'udivx', opc: 0x44, formats: ['D', 'S', 'S'], source: 'opcodes/e2k-opc.h:39', manual: 'UDIVX — деление без знака 64/32→32', asText: 'udivx,5 %db[2], %b[3], %b[4]' },
  { mnemonic: 'umodx', opc: 0x45, formats: ['D', 'S', 'S'], source: 'opcodes/e2k-opc.h:44', manual: 'UMODX — остаток без знака 64/32→32', asText: 'umodx,5 %db[2], %b[3], %b[4]' },
  { mnemonic: 'sdivx', opc: 0x46, formats: ['D', 'S', 'S'], source: 'opcodes/e2k-opc.h:49', manual: 'SDIVX — деление со знаком 64/32→32', asText: 'sdivx,5 %db[2], %b[3], %b[4]' },
  { mnemonic: 'smodx', opc: 0x47, formats: ['D', 'S', 'S'], source: 'opcodes/e2k-opc.h:54', manual: 'SMODX — остаток со знаком 64/32→32', asText: 'smodx,5 %db[2], %b[3], %b[4]' },
];

/** Наша инструкция по форме: операнды в порядке таблицы МЦСТ (src1, src2, dst). */
function instructionOf(form: (typeof FORMS)[number]): AsmInstruction {
  const [first, second, third] = form.formats;
  return {
    mnemonic: form.mnemonic,
    channel: 5,
    operands: [
      first === 'D' ? dreg(2) : reg(2),
      second === 'D' ? dreg(3) : reg(3),
      third === 'D' ? dreg(4) : reg(4),
    ],
  };
}

describe('формы деления и остатка: из источника', () => {
  it('все восемь форм есть в таблице — с кодом, форматом и каналами из opcodes/e2k-opc.h', () => {
    const missing: string[] = [];
    for (const form of FORMS) {
      const entry = realOpcode(form.mnemonic);
      if (entry === undefined) {
        missing.push(`${form.mnemonic} (${form.manual})`);
        continue;
      }
      expect(entry.opc, `${form.mnemonic}: код операции`).toBe(form.opc);
      expect(entry.form, `${form.mnemonic}: форма`).toBe('ALF1');
      expect(entry.channels, `${form.mnemonic}: каналы — в таблице МЦСТ только пятый`).toEqual([5]);
      expect(entry.operands, `${form.mnemonic}: порядок операндов`).toEqual(['src1', 'src2', 'dst']);
      expect(entry.source, `${form.mnemonic}: источник`).toContain(form.source);
    }
    expect(missing, 'формы, которых нет в таблице (записать «НЕТ В ИСТОЧНИКЕ», если так)').toEqual([]);
    // И ни одна из них не выдумана: имена есть в таблице МЦСТ по этим строкам.
    expect(FORMS.map((form) => form.mnemonic).sort()).toEqual(
      ['sdivd', 'sdivs', 'sdivx', 'smodx', 'udivd', 'udivs', 'udivx', 'umodx'],
    );
  });

  it('байты совпадают с ассемблером МЦСТ (замер .tmp/div-forms.ts)', () => {
    // Байты замерены `as-new -mcpu=elbrus-v5`; здесь они пришпилены, чтобы расхождение было видно
    // и без живого ассемблера.
    const measured: Readonly<Record<string, string>> = {
      sdivs: '01 00 00 80 04 03 02 42',
      udivs: '01 00 00 80 04 03 02 40',
      sdivd: '01 00 00 80 04 03 02 43',
      udivd: '01 00 00 80 04 03 02 41',
      sdivx: '01 00 00 80 04 03 02 46',
      udivx: '01 00 00 80 04 03 02 44',
      smodx: '01 00 00 80 04 03 02 47',
      umodx: '01 00 00 80 04 03 02 45',
    };
    for (const form of FORMS) {
      const bytes = encoder.encode(instructionOf(form));
      const hex = [...bytes].map((byte) => byte.toString(16).padStart(2, '0').toUpperCase()).join(' ');
      expect(hex, `${form.mnemonic}: байты наши против ассемблера МЦСТ`).toBe(measured[form.mnemonic]);
      expect(bytes.length, `${form.mnemonic}: длина`).toBe(8);
    }
  });

  it('канал, кроме пятого, — отказ: в таблице МЦСТ форма живёт только в пятом', () => {
    for (const channel of [0, 1, 2, 3, 4]) {
      expect(
        () => encoder.encode({ ...instructionOf(FORMS[0]!), channel }),
        `sdivs в канале ${channel} обязан быть отвергнут`,
      ).toThrow(EncodingRefusedError);
    }
  });

  it('чужая разрядность — отказ, а не молчаливая подстановка', () => {
    // `sdivs` требует S-операнды: с 64-битным приёмником кодировать нельзя.
    expect(() =>
      encoder.encode({ mnemonic: 'sdivs', channel: 5, operands: [reg(2), reg(3), dreg(4)] }),
    ).toThrow();
  });

  it('ассемблер МЦСТ собирает те же тексты — и его байты те же (живая сверка)', () => {
    const { tool } = findExternalAs();
    if (tool === undefined) return; // причина ненайденности названа в e2kExternalAs.test.ts
    const samples: AsSample[] = FORMS.map((form) => ({
      key: form.mnemonic,
      mnemonic: form.mnemonic,
      channel: 5,
      form: `ALOPF1 (${form.formats.join('')})`,
      asText: form.asText,
      instruction: instructionOf(form),
      source: form.source,
    }));
    const results = assembleAll(samples);
    results.forEach((result, at) => {
      const form = FORMS[at]!;
      expect(result.ok, `${form.mnemonic}: ассемблер не собрал`).toBe(true);
      if (!result.ok) return;
      const theirs = [...result.bytes].map((byte) => byte.toString(16).padStart(2, '0').toUpperCase()).join(' ');
      const ours = [...encoder.encode(instructionOf(form))].map((byte) => byte.toString(16).padStart(2, '0').toUpperCase()).join(' ');
      expect(ours, `${form.mnemonic}: наши байты против живого ассемблера`).toBe(theirs);
    });
  });
});
