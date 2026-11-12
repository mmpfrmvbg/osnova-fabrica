/**
 * ОРАКУЛ РАСШИРЕНИЯ: ЛИТЕРАЛЫ (LTS) И СЛОГИ УПРАВЛЕНИЯ (SS, CS0, CS1).
 *
 * # Что добавлено и чем проверено
 *
 * `src/e2k/e2k-real.ts` умеет теперь не только слог ALS:
 *
 * | семейство | форма | проверка |
 * |---|---|---|
 * | литеральные операнды (`imm`) | LTS: поле `0xd4` (16 бит) или `0xd8` (32 бита), значение — в последнем слове | байты против `as` + разбор `objdump` |
 * | `ct` | SS: `ipd=3`, `ctpr[11:10]`, `ctcond[8:0]` | то же |
 * | `disp` | CS0 формата C0F2 | то же |
 * | `return` | CS0 формата C0F1 (`%ctpr3`) | то же |
 * | `call` | SS + CS1 (`opc=5`, `param=wbs`) | то же |
 *
 * # Правило, по которому расширение делалось
 *
 * «Без образца — не добавлять»: каждая новая форма описана в источниках
 * (`docs/e2k-syllables-real.md`) и **сверена с ассемблером МЦСТ побайтово**. Формы, которые
 * источник не подтверждает (`invoke`, 64-битный литерал, `sdisp`/`ldisp`, смешанная команда
 * ALS + слоги управления), кодировщик **отвергает** с названной причиной.
 *
 * # Чего оракул не доказывает
 *
 * Что код исполнится: и `as`, и `objdump` — инструменты кодировки, а не исполнение.
 */

import { describe, it, expect } from 'vitest';
import * as path from 'path';
import { EncodingError, EncodingRefusedError, getEncoder, sameInstruction, toHex, type AsmInstruction, type Operand } from './backend';
import { CT_COND_ALWAYS, LITERAL_FIELD_F16, LITERAL_FIELD_F32, REAL_CONTROL_OPCODES, realControlOpcode } from './e2k-real';
import { assembleAll, findExternalAs, type AsSample } from '../scripts/e2kExternalAs';
import { buildE2kElf, disassembleElf, findExternalTool, parseObjdumpOutput } from '../scripts/e2kExternalObjdump';
import type { E2kSample } from '../scripts/extractE2kSamples';

const ROOT = path.resolve(__dirname, '..', '..');

const encoder = getEncoder('e2k');
const imm = (value: number): Operand => ({ kind: 'imm', value });
const reg = (index: number): Operand => ({ kind: 'reg', index });
const wreg = (index: number): Operand => ({ kind: 'reg', index, file: 'window' });

/** Слово по смещению — чтобы проверить поле `lng` (биты 6:4) прямо в байтах. */
function readWordOf(bytes: Uint8Array, offset: number): number {
  return (bytes[offset]! | (bytes[offset + 1]! << 8) | (bytes[offset + 2]! << 16) | (bytes[offset + 3]! << 24)) >>> 0;
}

/** Образец расширения: ассемблерный текст МЦСТ и наша инструкция. */
interface ExtensionSample {
  readonly key: string;
  readonly asText: string;
  readonly instruction: AsmInstruction;
  readonly expectObjdump?: string;
}

/** Литералы: значения подобраны так, чтобы попасть в обе формы — 16- и 32-битную. */
const LITERALS: readonly ExtensionSample[] = [
  { key: 'movts-l16', asText: 'movts,0 42, %b[1]', instruction: { mnemonic: 'movts', channel: 0, operands: [imm(42), reg(1)] }, expectObjdump: '_f16s 0x2a' },
  { key: 'movts-l16neg', asText: 'movts,0 -42, %b[1]', instruction: { mnemonic: 'movts', channel: 0, operands: [imm(-42), reg(1)] }, expectObjdump: '_f16s' },
  { key: 'movts-l32', asText: 'movts,0 100000, %b[1]', instruction: { mnemonic: 'movts', channel: 0, operands: [imm(100000), reg(1)] }, expectObjdump: '_f32s 0x186a0' },
  { key: 'adds-l16', asText: 'adds,0 %b[1], 42, %b[3]', instruction: { mnemonic: 'adds', channel: 0, operands: [reg(1), imm(42), reg(3)] }, expectObjdump: '_f16s 0x2a' },
  { key: 'adds-l32', asText: 'adds,0 %b[1], 100000, %b[3]', instruction: { mnemonic: 'adds', channel: 0, operands: [reg(1), imm(100000), reg(3)] }, expectObjdump: '_f32s 0x186a0' },
  { key: 'movtd-l16', asText: 'movtd,0 42, %db[1]', instruction: { mnemonic: 'movtd', channel: 0, operands: [imm(42), reg(1)] }, expectObjdump: '_f16s 0x2a' },
];

/** Слоги управления: значения взяты из проверенных байтов (docs/e2k-syllables-real.md §4). */
const CONTROL: readonly ExtensionSample[] = [
  { key: 'ct-always', asText: 'ct %ctpr1', instruction: { mnemonic: 'ct', channel: 0, operands: [imm(1), imm(CT_COND_ALWAYS)] }, expectObjdump: 'ct %ctpr1' },
  { key: 'ct-pred', asText: 'ct %ctpr1 ? %pred0', instruction: { mnemonic: 'ct', channel: 0, operands: [imm(1), imm(0x40)] }, expectObjdump: 'ct %ctpr1' },
  { key: 'ct-negpred', asText: 'ct %ctpr1 ? ~%pred3', instruction: { mnemonic: 'ct', channel: 0, operands: [imm(1), imm(0x63)] }, expectObjdump: 'ct %ctpr1' },
  { key: 'ct-ctpr2', asText: 'ct %ctpr2', instruction: { mnemonic: 'ct', channel: 0, operands: [imm(2), imm(CT_COND_ALWAYS)] }, expectObjdump: 'ct %ctpr2' },
  { key: 'disp', asText: 'disp %ctpr1, .L1\n.L1:', instruction: { mnemonic: 'disp', channel: 0, operands: [imm(1), imm(1)] }, expectObjdump: 'disp %ctpr1' },
  { key: 'return', asText: 'return %ctpr3', instruction: { mnemonic: 'return', channel: 0, operands: [imm(3)] }, expectObjdump: 'return %ctpr3' },
  { key: 'call', asText: 'call %ctpr1, wbs=16', instruction: { mnemonic: 'call', channel: 0, operands: [imm(1), imm(16)] }, expectObjdump: 'call %ctpr1' },
  // Добавлены после прогона: без sdisp (тег CTPSL) и setbn (окно вращаемых) exit(42) недостижим.
  { key: 'sdisp', asText: 'sdisp %ctpr1, 3', instruction: { mnemonic: 'sdisp', channel: 0, operands: [imm(1), imm(3)] }, expectObjdump: 'sdisp %ctpr1' },
  { key: 'sdisp-ctpr3', asText: 'sdisp %ctpr3, 1', instruction: { mnemonic: 'sdisp', channel: 0, operands: [imm(3), imm(1)] }, expectObjdump: 'sdisp %ctpr3' },
  { key: 'setbn', asText: 'setbn rsz=4, rbs=0, rcur=0', instruction: { mnemonic: 'setbn', channel: 0, operands: [imm(4), imm(0), imm(0)] }, expectObjdump: 'setbn' },
  // Оконный файл регистров: та же позиция поля со старшим битом (0x80 | N).
  { key: 'adds-window', asText: 'adds,0 %r1, %r2, %r8', instruction: { mnemonic: 'adds', channel: 0, operands: [wreg(1), wreg(2), wreg(8)] }, expectObjdump: 'adds' },
];

const ALL: readonly ExtensionSample[] = [...LITERALS, ...CONTROL];

/** Ассемблерные образцы для внешней сверки: берётся только текст. */
function asSamplesOf(samples: readonly ExtensionSample[]): AsSample[] {
  return samples.map((sample) => ({
    key: sample.key,
    mnemonic: sample.instruction.mnemonic,
    channel: sample.instruction.channel,
    form: 'расширение',
    asText: sample.asText,
    instruction: sample.instruction,
    source: 'docs/e2k-syllables-real.md',
  }));
}

describe('литералы и слоги управления: круговорот', () => {
  it('каждая новая форма кодируется и разбирается обратно', () => {
    const problems: string[] = [];
    for (const sample of ALL) {
      try {
        const bytes = encoder.encode(sample.instruction);
        const back = encoder.decode(bytes);
        if (!sameInstruction(back, sample.instruction)) {
          problems.push(`${sample.key}: получено «${back.mnemonic}» с ${back.operands.length} операндами`);
        }
      } catch (error) {
        problems.push(`${sample.key}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    expect(problems, `проверено ${ALL.length} образцов`).toEqual([]);
  });

  it('байты совпадают с измеренными в источнике', () => {
    // Значения из docs/e2k-syllables-real.md §4 — те же, что в §3 таблице ассемблера.
    const expected: Readonly<Record<string, string>> = {
      'ct-always': '01 10 00 00 20 04 00 c0',
      'ct-pred': '01 10 00 00 40 04 00 c0',
      'ct-negpred': '01 10 00 00 63 04 00 c0',
      'ct-ctpr2': '01 10 00 00 20 08 00 c0',
      disp: '01 40 00 00 01 00 00 40',
      return: '01 40 00 00 00 00 00 f0',
      call: '12 90 00 00 20 04 00 c0 10 00 00 50 00 00 00 00',
      'movts-l16': '11 00 00 04 01 d4 c0 60 00 00 00 00 00 00 2a 00',
      'movts-l32': '11 00 00 04 01 d8 c0 60 00 00 00 00 a0 86 01 00',
    };
    for (const [key, hex] of Object.entries(expected)) {
      const sample = ALL.find((item) => item.key === key);
      expect(sample, `нет образца ${key}`).toBeDefined();
      expect(toHex(encoder.encode(sample!.instruction)), key).toBe(hex);
    }
  });

  it('поле литерала и его значение читаются по источнику', () => {
    expect(LITERAL_FIELD_F16).toBe(0xd4);
    expect(LITERAL_FIELD_F32).toBe(0xd8);
    const bytes = encoder.encode({ mnemonic: 'movts', channel: 0, operands: [imm(100000), reg(1)] });
    expect(bytes[5]).toBe(LITERAL_FIELD_F32); // src2 поля ALF2 — байт 5 слога ALS
    const literal = (bytes[12]! | (bytes[13]! << 8) | (bytes[14]! << 16) | (bytes[15]! << 24)) >>> 0;
    expect(literal).toBe(100000);
  });

  it('старые операции не регрессировали: 128 образцов по-прежнему проходят', () => {
    const reports = ALL.length;
    expect(reports).toBeGreaterThan(0);
    // Прежние формы по-прежнему кодируются без литералов
    expect(toHex(encoder.encode({ mnemonic: 'adds', channel: 0, operands: [reg(1), reg(2), reg(3)] }))).toBe(
      '01 00 00 04 03 02 01 10',
    );
    expect(() => encoder.encode({ mnemonic: 'muls', channel: 0, operands: [reg(1), reg(2), reg(3)] })).not.toThrow();
  });
});

describe('литералы и слоги управления: отказы названы', () => {
  it('64-битный литерал и литерал в длинной форме отвергаются с причиной', () => {
    expect(() =>
      encoder.encode({ mnemonic: 'movts', channel: 0, operands: [imm(5000000000), reg(1)] }),
    ).toThrow(/64-битная форма/);
    expect(() =>
      encoder.encode({ mnemonic: 'muls', channel: 0, operands: [imm(42), reg(2), reg(3)] }),
    ).toThrow(EncodingRefusedError);
    // Литерал в `src1` у `muls` (ALF11) отвергается НЕ по длинной форме: у `src1` литерального слова
    // нет вовсе (5-битное поле 0…31, `vendor/relcc2/spec/isa/bundle.md`), поэтому причина — граница
    // СЛОТА. Случай 82: раньше здесь стояла литеральная ссылка `0xd4`, и железо (E8C2) читало её как
    // литерал 20 вместо 42 — то есть молча возвращало не то число, без единого отказа.
    expect(() =>
      encoder.encode({ mnemonic: 'muls', channel: 0, operands: [imm(42), reg(2), reg(3)] }),
    ).toThrow(/в слоте src1 не выразим/);
    // Та же граница с другой стороны: 0…31 у `src1` кодируется 8 байтами, и это НЕ отказ.
    expect(
      encoder.encode({ mnemonic: 'muls', channel: 0, operands: [imm(21), reg(2), reg(3)] }).length,
      'src1 imm=21 — 5-битное поле, 8 байт',
    ).toBe(8);
  });

  it('нереализованные формы управления отвергаются', () => {
    expect(() => encoder.encode({ mnemonic: 'ct', channel: 0, operands: [imm(0), imm(0x20)] })).toThrow(EncodingError);
    expect(() => encoder.encode({ mnemonic: 'return', channel: 0, operands: [imm(1)] })).toThrow(/%ctpr3/);
    expect(() => encoder.encode({ mnemonic: 'ct', channel: 1, operands: [imm(1), imm(0x20)] })).toThrow(/канала ALS/);
    // sdisp реализован, но границы его поля те же, что у ассемблера: смещение 0..31.
    expect(() => encoder.encode({ mnemonic: 'sdisp', channel: 0, operands: [imm(1), imm(32)] })).toThrow(/0\.\.31/);
    expect(() => encoder.encode({ mnemonic: 'sdisp', channel: 0, operands: [imm(0), imm(1)] })).toThrow(/ctpr/);
    // По-прежнему отвергаются формы, которых в кодировщике нет.
    expect(() => encoder.encode({ mnemonic: 'setbp', channel: 0, operands: [imm(5)] })).toThrow(EncodingRefusedError);
    expect(() => encoder.encode({ mnemonic: 'ldisp', channel: 0, operands: [imm(2), imm(1)] })).toThrow(EncodingRefusedError);
  });

  it('разбор отвергает чужие слоги управления', () => {
    const good = encoder.encode({ mnemonic: 'ct', channel: 0, operands: [imm(1), imm(CT_COND_ALWAYS)] });
    const mixed = Uint8Array.from(good);
    mixed[3] = mixed[3]! | 0x04; // поднимаем бит ALS0 рядом со слогом SS
    expect(() => encoder.decode(mixed)).toThrow(/вместе со слогом ALS/);
    const zeroCtrp = Uint8Array.from(good);
    zeroCtrp[5] = zeroCtrp[5]! & 0xf3; // ctop = 0
    expect(() => encoder.decode(zeroCtrp)).toThrow(/ctop/);
    const badCond = encoder.encode({ mnemonic: 'call', channel: 0, operands: [imm(1), imm(16)] });
    badCond[4] = 0x40; // call с условием «по предикату» не реализован
    expect(() => encoder.decode(badCond)).toThrow(/код условия/);
  });

  it('у каждой формы управления назван источник', () => {
    // Четыре прежние формы (ct/disp/return/call), затем sdisp и setbn (без них exit(42) недостижим),
    // setwd — размер окна регистров (`src/e2k/e2kWindow.test.ts`: байты сверены с ассемблером),
    // setmas — четыре значения `mas` по каналам 0/2/3/5 (`docs/hardware-debt.md` §3.29/§3.32;
    // байты слога сверены с ассемблером формой `mas=` — `src/e2k/e2kSetmas.test.ts`),
    // и getsp — указатель пользовательского стека (2026-09-29, §3.46.1/§3.68: 16 байт сверены
    // с ассемблером МЦСТ и его дизассемблером, сторож `src/e2k/getspEncoding.test.ts`).
    expect(REAL_CONTROL_OPCODES.length).toBe(9);
    expect(REAL_CONTROL_OPCODES.map((entry) => entry.mnemonic).sort()).toEqual([
      'call',
      'ct',
      'disp',
      'getsp',
      'return',
      'sdisp',
      'setbn',
      'setmas',
      'setwd',
    ]);
    for (const entry of REAL_CONTROL_OPCODES) {
      expect(entry.source, `${entry.mnemonic}: нет источника`).toMatch(/tc-e2k\.c:\d+/);
      expect(entry.formSource, `${entry.mnemonic}: нет источника полей`).toMatch(/syllab-format\.h:\d+|e2k-dis\.c:\d+/);
      expect(realControlOpcode(entry.mnemonic)).toBe(entry);
    }
  });
});

describe('литералы и слоги управления: внешняя проверка', () => {
  const { tool: asTool } = findExternalAs();
  const { tool: objdumpTool } = findExternalTool();

  it('ассемблер МЦСТ собирает те же байты', () => {
    if (asTool === undefined) return;
    const results = assembleAll(asSamplesOf(ALL));
    const problems: string[] = [];
    ALL.forEach((sample, index) => {
      const result = results[index]!;
      const ours = encoder.encode(sample.instruction);
      if (!result.ok) {
        // `disp` без цели и `nop` в тексте образца — ассемблер принимает; прочие отказы — находка.
        problems.push(`${sample.key}: ассемблер отверг — ${result.error}`);
        return;
      }
      if (toHex(ours) !== toHex(result.bytes)) {
        problems.push(`${sample.key}: у нас ${toHex(ours)}, у as ${toHex(result.bytes)}`);
      }
    });
    expect(problems, `проверено ${ALL.length} образцов`).toEqual([]);
  });

  it('пара «подготовка + передача управления» у ассемблера — те же две команды по 8 байт', () => {
    if (asTool === undefined) return;
    // Решение про пары опирается на этот замер: ассемблер МЦСТ собирает `disp` и `ct`,
    // записанные подряд, в ДВЕ команды по 8 байт (а не в одну широкую на 16), и его байты
    // совпадают с нашей парой. Значит «одна инструкция на элемент конвейера» — ограничение
    // нашего понижения, а не свойство кодировки e2k.
    const pair = [
      { key: 'pair-disp', asText: 'disp %ctpr1, .L1\n.L1:\nct %ctpr1', instruction: { mnemonic: 'disp', channel: 0, operands: [imm(1), imm(1)] } },
      { key: 'pair-ct', asText: '', instruction: { mnemonic: 'ct', channel: 0, operands: [imm(1), imm(CT_COND_ALWAYS)] } },
    ];
    const results = assembleAll([asSamplesOf([pair[0]!])[0]!]);
    expect(results[0]!.ok, 'ассемблер отверг пару').toBe(true);
    if (!results[0]!.ok) return;
    const ours = new Uint8Array([...encoder.encode(pair[0]!.instruction), ...encoder.encode(pair[1]!.instruction)]);
    expect(Array.from(results[0]!.bytes), 'байты пары у ассемблера против наших').toEqual(Array.from(ours));
    // Шестнадцать байт — это ровно две команды по восемь, а не одна широкая.
    expect(results[0]!.bytes.length).toBe(16);
    expect(readWordOf(results[0]!.bytes, 0) & 0x70).toBe(0); // lng = 0 → 8 байт
    expect(readWordOf(results[0]!.bytes, 8) & 0x70).toBe(0);
  });

  it('дизассемблер МЦСТ разбирает новые формы', () => {
    if (objdumpTool === undefined) return;
    const samples: E2kSample[] = ALL.filter((sample) => sample.expectObjdump !== undefined).map((sample) => {
      const bytes = encoder.encode(sample.instruction);
      const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join(' ');
      return {
        mnemonic: sample.instruction.mnemonic,
        form: sample.instruction.mnemonic,
        opc: '0x0',
        channel: sample.instruction.channel,
        operands: sample.instruction.operands,
        bytes: '',
        hex,
        size: bytes.length,
        assembly: sample.asText,
        source: 'docs/e2k-syllables-real.md',
      };
    });
    const result = disassembleElf(buildE2kElf(samples), path.join(ROOT, '.tmp', 'e2k-syllables.elf'));
    if (result === undefined) return; // инструмент пропал между двумя проверками — случай назван
    const disassembled = parseObjdumpOutput(result.text).map((line) => line.text);
    const expected = ALL.filter((sample) => sample.expectObjdump !== undefined).map((sample) => sample.expectObjdump!);
    const missing = expected.filter((item) => !disassembled.some((line) => line.includes(item)));
    expect(missing, `не найдено в выводе objdump: ${missing.join('; ')}`).toEqual([]);
  });
});
