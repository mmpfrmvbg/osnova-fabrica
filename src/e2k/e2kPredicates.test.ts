/**
 * ОРАКУЛ ПРЕДИКАТОВ И СРАВНЕНИЙ — НАПИСАН ДО РЕАЛИЗАЦИИ.
 *
 * # Зачем это нужно для перехода
 *
 * `IR.jmp_if_not` несёт условие **регистром-значением**, а `ct` читает **предикат**
 * (`SS.ctcond.psrc[4:0]`, `qemu/target/e2k/syllab-format.h:196`; измерено: `ct %ctpr1 ? %pred0` →
 * `01 10 00 00 40 04 00 c0`, `? ~%pred0` → `... 60 04 00 c0`). Значение в регистре предикатом не
 * является, поэтому у интерфейса `Operand` до этой правки **нет способа выразить предикат** — этот
 * пробел записан долгом (`docs/hardware-debt.md` §3.7: «у интерфейса **нет способа выразить
 * предикат** (результат `cmp*`)»).
 *
 * # Что измерено внешним ассемблером (до реализации)
 *
 * | текст МЦСТ | байты |
 * |---|---|
 * | `cmplsb,0 %b[1], %b[2], %pred0` | `01 01 00 04 c0 02 01 20` |
 * | `cmplsb,0 %b[1], %b[2], %pred3` | `01 01 00 04 c3 02 01 20` |
 * | `cmplesb,0 %b[1], %b[2], %pred0` | `01 01 00 04 e0 02 01 20` |
 * | `cmpesb,0 %b[1], %b[2], %pred0` | `01 01 00 04 40 02 01 20` |
 * | `cmplsb,0 %r1, %r2, %pred0` | `01 01 00 04 c0 82 81 20` |
 *
 * Отсюда раскладка слова ALF7: `opc[31:24]`, `src1[23:16]`, `src2[15:8]`,
 * `cmpopce[7:5] | pdst[4:0]` — байт 0 = `0xc0` для условия «меньше» (`cmpopce = 6`), `0xe0` для
 * «меньше или равно» (7), `0x40` для «равно» (2). Значения `cmpopce` — из таблицы МЦСТ
 * (`opcodes/e2k-opc.h:989-1064`: последнее числовое поле записи `e2k_alf7_opcode_templ`).
 *
 * # Находка: у `cmp` есть ОБЯЗАТЕЛЬНОЕ поле `nop = 2`
 *
 * HS слова `cmp` — не `01 00 00 04`, как у `adds`, а `01 01 00 04`: биты 9:7 (поле `nop`) равны 2.
 * Причина названа в источнике: `gas/config/tc-e2k.c:5923` берёт это число из шаблона записи
 * (`((e2k_alf7_opcode_templ *) alf)->implicit_nops`), а в таблице у каждой записи `cmp*` стоит
 * `2`. Дизассемблер МЦСТ печатает это же поле открытым текстом: `nop 2`.
 *
 * # Чего оракул НЕ доказывает
 *
 * Что **смысл** `nop 2` понят нами верно. Поле означает, что за командой оставлены два слота
 * выдачи; значит предикат `cmp` готов не мгновенно, и `ct`, читающий его, обязан отстоять от
 * `cmp`. Мы это учитываем порядком серии (`cmp`, `disp`, `ct` — между ними ровно два слота), но
 * **проверкой это не подтверждено**: ни QEMU, ни железо здесь готовность предиката не мерят.
 * Утверждение записано как допущение, а не как факт.
 *
 * Что код исполнится: `as` и `objdump` — инструменты кодировки.
 */

import * as fs from 'fs';
import * as path from 'path';
import { describe, it, expect } from 'vitest';
import { getEncoder, sameInstruction, toHex, type AsmInstruction, type Operand } from './backend';
import { REAL_OPCODES } from './e2k-real';
import { assembleAll, findExternalAs, type AsSample } from '../scripts/e2kExternalAs';
import { buildE2kElf, disassembleElf, findExternalTool, parseObjdumpOutput } from '../scripts/e2kExternalObjdump';
import type { E2kSample } from '../scripts/extractE2kSamples';

const ROOT = path.resolve(__dirname, '..', '..');
const encoder = getEncoder('e2k');

// Внешний as живёт только на Windows-хосте (WSL). На Linux-облаке L1 его нет,
// поэтому секция внешней сверки пропускается с названной причиной; чистое
// кодирование и разбор остаются в полном прогоне.
const externalAs = findExternalAs();
if (externalAs.tool === undefined) console.warn(`[L1] предикаты: внешняя сверка пропущена: ${externalAs.reason}`);
const describeExternalAs = externalAs.tool === undefined ? describe.skip : describe;

const reg = (index: number): Operand => ({ kind: 'reg', index });
/** Предикат — ОТДЕЛЬНЫЙ вид операнда: смешать `%pred0` с `%b[0]` нельзя. */
const pred = (index: number): Operand => ({ kind: 'pred', index }) as unknown as Operand;
const imm = (value: number): Operand => ({ kind: 'imm', value });
const asm = (mnemonic: string, operands: readonly Operand[]): AsmInstruction => ({
  mnemonic,
  channel: 0,
  operands,
});

/** Измеренные ассемблером МЦСТ байты — эталон, а не наш пересказ. */
const MEASURED: ReadonlyArray<{ key: string; instruction: AsmInstruction; hex: string; asText: string }> = [
  {
    key: 'cmplsb-pred0',
    instruction: asm('cmplsb', [reg(1), reg(2), pred(0)]),
    hex: '01 01 00 04 c0 02 01 20',
    asText: 'cmplsb,0 %b[1], %b[2], %pred0',
  },
  {
    key: 'cmplsb-pred3',
    instruction: asm('cmplsb', [reg(1), reg(2), pred(3)]),
    hex: '01 01 00 04 c3 02 01 20',
    asText: 'cmplsb,0 %b[1], %b[2], %pred3',
  },
  {
    key: 'cmplesb-pred0',
    instruction: asm('cmplesb', [reg(1), reg(2), pred(0)]),
    hex: '01 01 00 04 e0 02 01 20',
    asText: 'cmplesb,0 %b[1], %b[2], %pred0',
  },
  {
    key: 'cmpesb-pred0',
    instruction: asm('cmpesb', [reg(1), reg(2), pred(0)]),
    hex: '01 01 00 04 40 02 01 20',
    asText: 'cmpesb,0 %b[1], %b[2], %pred0',
  },
  {
    key: 'cmplsb-window',
    instruction: asm('cmplsb', [{ kind: 'reg', index: 1, file: 'window' }, { kind: 'reg', index: 2, file: 'window' }, pred(0)]),
    hex: '01 01 00 04 c0 82 81 20',
    asText: 'cmplsb,0 %r1, %r2, %pred0',
  },
];

describe('предикаты: 1. таблица сравнений и разрядность полей', () => {
  it('в таблице кодировщика есть сравнения с предикатом-приёмником', () => {
    const comparisons = REAL_OPCODES.filter((entry) => entry.operands.includes('pdst'));
    expect(comparisons.length, 'ни одной записи с предикатом-приёмником').toBeGreaterThanOrEqual(3);
    for (const entry of comparisons) {
      expect(entry.form, `${entry.mnemonic}: форма`).toBe('ALF7');
      expect(entry.operands.at(-1), `${entry.mnemonic}: приёмник предиката последним`).toBe('pdst');
      expect(entry.source, `${entry.mnemonic}: источник не назван`).toMatch(/opcodes\/e2k-opc\.h:\d+/);
      // Обязательное поле nop = 2: источник — implicit_nops записи ALF7.
      expect(entry.implicitNops, `${entry.mnemonic}: не названо поле nop`).toBe(2);
    }
    const byName = new Map(comparisons.map((entry) => [entry.mnemonic, entry]));
    for (const mnemonic of ['cmplsb', 'cmplesb', 'cmpesb']) {
      expect(byName.has(mnemonic), `нет сравнения ${mnemonic}`).toBe(true);
    }
    // Условия «больше»/«больше или равно» в наборе НЕТ — они выражаются отрицанием предиката.
    expect(byName.has('cmpgsb'), 'в наборе не должно быть условия g').toBe(false);
    expect(byName.get('cmplsb')!.cmpOpce, 'cmplsb: код условия «меньше»').toBe(6);
    expect(byName.get('cmplesb')!.cmpOpce, 'cmplesb: код условия «меньше или равно»').toBe(7);
    expect(byName.get('cmpesb')!.cmpOpce, 'cmpesb: код условия «равно»').toBe(2);
  });
});

describe('предикаты: 2. кодирование и круг', () => {
  it('байты совпадают с измеренными ассемблером МЦСТ', () => {
    for (const sample of MEASURED) {
      expect(toHex(encoder.encode(sample.instruction)), `${sample.key} (${sample.asText})`).toBe(sample.hex);
    }
  });

  it('поле nop = 2 и код условия читаются прямо в байтах', () => {
    const bytes = encoder.encode(asm('cmplsb', [reg(1), reg(2), pred(0)]));
    const hs = bytes[0]! | (bytes[1]! << 8) | (bytes[2]! << 16) | (bytes[3]! << 24);
    expect((hs >>> 7) & 0x7, 'поле nop (биты 9:7)').toBe(2);
    const word = bytes[4]! | (bytes[5]! << 8) | (bytes[6]! << 16) | (bytes[7]! << 24);
    expect((word >>> 24) & 0x7f, 'код операции').toBe(0x20);
    expect((word >>> 16) & 0xff, 'src1').toBe(1);
    expect((word >>> 8) & 0xff, 'src2').toBe(2);
    expect((word >>> 5) & 0x7, 'cmpopce').toBe(6);
    expect(word & 0x1f, 'pdst').toBe(0);
  });

  it('круг: предикат разбирается обратно тем же номером', () => {
    for (const sample of MEASURED) {
      const back = encoder.decode(encoder.encode(sample.instruction));
      expect(sameInstruction(back, sample.instruction), `${sample.key}: разобрано «${back.mnemonic}»`).toBe(true);
      expect(back.operands.at(-1), `${sample.key}: приёмник`).toEqual(sample.instruction.operands.at(-1));
    }
    for (const number of [0, 3, 7, 31]) {
      const instruction = asm('cmplesb', [reg(2), reg(3), pred(number)]);
      const back = encoder.decode(encoder.encode(instruction));
      expect(back.operands.at(-1), `%pred${number}`).toEqual(pred(number));
    }
  });

  it('ct с предикатом кодируется и разбирается — обе полярности', () => {
    const direct = asm('ct', [imm(1), imm(0x40 | 3)]);
    const inverted = asm('ct', [imm(1), imm(0x60 | 7)]);
    expect(toHex(encoder.encode(direct))).toBe('01 10 00 00 43 04 00 c0');
    expect(toHex(encoder.encode(inverted))).toBe('01 10 00 00 67 04 00 c0');
    for (const instruction of [direct, inverted]) {
      expect(sameInstruction(encoder.decode(encoder.encode(instruction)), instruction)).toBe(true);
    }
  });
});

describe('предикаты: 3. отказы названы, а не подставлены', () => {
  it('номер предиката вне 0..31 — отказ с причиной', () => {
    for (const number of [-1, 32, 64]) {
      expect(() => encoder.encode(asm('cmplsb', [reg(1), reg(2), pred(number)]))).toThrow(
        /0\.\.31|предикат/,
      );
    }
  });

  it('предикат там, где нужен регистр, и регистр там, где нужен предикат — отказ', () => {
    // Смешать файлы нельзя: `%pred0` и `%b[0]` — разные ячейки, и молчаливая подстановка
    // одного вместо другого была бы подменой поля.
    expect(() => encoder.encode(asm('cmplsb', [reg(1), reg(2), reg(0)]))).toThrow(/предикат/);
    expect(() => encoder.encode(asm('adds', [reg(1), reg(2), pred(0)]))).toThrow(/регистр/);
    expect(() => encoder.encode(asm('cmplsb', [pred(1), reg(2), pred(0)]))).toThrow(/регистр/);
  });

  it('точное число операндов: у сравнения их три', () => {
    expect(() => encoder.encode(asm('cmplsb', [reg(1), reg(2)]))).toThrow(/операнд/);
    expect(() => encoder.encode(asm('cmplsb', [reg(1), reg(2), pred(0), reg(3)]))).toThrow(/операнд/);
  });
});

describeExternalAs('предикаты: 4. внешняя сверка (as и objdump)', () => {
  it('ассемблер МЦСТ собирает те же байты', () => {
    const samples: AsSample[] = MEASURED.map((sample) => ({
      key: sample.key,
      mnemonic: sample.instruction.mnemonic,
      channel: sample.instruction.channel,
      form: 'ALF7',
      asText: sample.asText,
      instruction: sample.instruction,
      source: 'opcodes/e2k-opc.h:1024',
    }));
    const results = assembleAll(samples);
    const problems: string[] = [];
    MEASURED.forEach((sample, index) => {
      const result = results[index]!;
      if (!result.ok) {
        problems.push(`${sample.key}: ассемблер отверг — ${result.error}`);
        return;
      }
      if (toHex(encoder.encode(sample.instruction)) !== toHex(result.bytes)) {
        problems.push(`${sample.key}: у нас ${toHex(encoder.encode(sample.instruction))}, у as ${toHex(result.bytes)}`);
      }
    });
    expect(problems, `проверено ${MEASURED.length} образцов`).toEqual([]);
  });

  it('дизассемблер МЦСТ печатает наши предикаты', () => {
    const { tool } = findExternalTool();
    if (tool === undefined) {
      const probe = findExternalTool();
      expect(probe.reason, 'причина ненайденности дизассемблера не названа').toBeDefined();
      return;
    }
    const samples: E2kSample[] = MEASURED.filter((sample) => sample.key !== 'cmplsb-window').map((sample) => ({
      mnemonic: sample.instruction.mnemonic,
      form: 'ALF7',
      opc: '0x20',
      channel: 0,
      operands: sample.instruction.operands,
      bytes: '',
      hex: toHex(encoder.encode(sample.instruction)),
      size: 8,
      assembly: sample.asText,
      source: 'opcodes/e2k-opc.h:1024',
    }));
    const result = disassembleElf(buildE2kElf(samples), path.join(ROOT, '.tmp', 'e2k-predicates.elf'));
    if (result === undefined) return; // инструмент пропал между проверками — случай назван
    const lines = parseObjdumpOutput(result.text).map((line) => line.text);
    const missing = [
      ...MEASURED.filter((sample) => sample.key !== 'cmplsb-window').map((sample) => sample.asText.split(',0 ')[1]!),
      'nop 2',
    ].filter((expected) => !lines.some((line) => line.includes(expected)));
    expect(missing, `не найдено в выводе objdump: ${missing.join('; ')}`).toEqual([]);
  });

  it('НЕГАТИВНЫЙ КОНТРОЛЬ: подмена условия меняет байты, а подмена поля nop ловится', () => {
    // Условие «меньше» против «меньше или равно» — разные коды, байты обязаны разойтись.
    const less = encoder.encode(asm('cmplsb', [reg(1), reg(2), pred(0)]));
    const lessEqual = encoder.encode(asm('cmplesb', [reg(1), reg(2), pred(0)]));
    expect(toHex(less)).not.toBe(toHex(lessEqual));
    expect((less[4]! >>> 5) & 0x7).toBe(6);
    expect((lessEqual[4]! >>> 5) & 0x7).toBe(7);
    // Поле nop: если его не ставить, HS отличается от измеренного ассемблером на бит 8.
    const withoutNop = Uint8Array.from(less);
    withoutNop[1] = withoutNop[1]! & 0xfe;
    expect(toHex(withoutNop)).not.toBe(toHex(less));
    expect(() => encoder.decode(withoutNop), 'разбор обязан заметить подменённое поле nop').toThrow(
      /nop|поле/,
    );
    // И наоборот: наш разбор не должен принимать cmp без поля nop молча.
    expect(() => encoder.decode(encoder.encode(asm('adds', [reg(1), reg(2), reg(3)])))).not.toThrow();
  });
});

describe('предикаты: 5. источник поля nop читается в исходниках', () => {
  it('implicit_nops = 2 у записей ALF7 и установка поля — в gas', () => {
    const gas = path.join(ROOT, '.tmp', 'e2k-sources', 'binutils-gdb', 'gas', 'config', 'tc-e2k.c');
    const table = path.join(ROOT, '.tmp', 'e2k-sources', 'binutils-gdb', 'opcodes', 'e2k-opc.h');
    if (!fs.existsSync(gas) || !fs.existsSync(table)) {
      expect(fs.existsSync(gas) && fs.existsSync(table), 'исходников под рукой нет — причина названа').toBe(false);
      return;
    }
    const gasText = fs.readFileSync(gas, 'utf-8');
    expect(gasText, 'поле nop берётся не из шаблона ALF7').toMatch(/wc\.nop_nmb\s*=\s*\(\(e2k_alf7_opcode_templ \*\)\s*alf\)->implicit_nops/);
    expect(gasText, 'поле nop не записывается в HS').toMatch(/hs->nop\s*=\s*wc\.nop_nmb/);
    // В таблице у записи сравнения последнее числовое поле — это implicit_nops = 2.
    const tableText = fs.readFileSync(table, 'utf-8');
    const entry = /"cmplsb"[^;]*?;\s*\n\s*add_to_insn_table/.exec(tableText);
    expect(entry, 'в таблице нет записи cmplsb').not.toBeNull();
    expect(entry![0], 'у записи cmplsb нет implicit_nops = 2').toMatch(/, 2, 1\};\s*\n\s*add_to_insn_table/);
  });
});
