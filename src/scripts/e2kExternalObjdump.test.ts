/**
 * ОРАКУЛ ВНЕШНЕЙ ПРОВЕРКИ КОДИРОВКИ e2k ЧЕРЕЗ MCST-ДИЗАССЕМБЛЕР.
 *
 * # Что проверяется
 *
 * `src/scripts/e2kExternalObjdump.ts` упаковывает образцы в ELF с `e_machine = 175` и отдаёт
 * **чужому** дизассемблеру — `objdump` из binutils МЦСТ, собранного в WSL. Тест проверяет:
 *
 * 1. **Упаковка.** Адреса раскладки идут подряд с выравниванием до 16 байт, размеры совпадают
 *    с образцами, `e_machine` и `e_flags` — те, что нужны (`EM_E2K = 175`, машина 8c → уровень
 *    ISA 4).
 * 2. **Разбор вывода.** Вывод дизассемблера необычен: адрес печатается **без** байтов, текст
 *    инструкции — следующей строкой. Разбор проверяется негативным контролем на подложенном
 *    тексте (в том числе на пустом и на чужом формате).
 * 3. **Сверка.** Если внешний дизассемблер доступен, **все десять** образцов обязаны совпасть
 *    по мнемонике, каналу и номерам операндов. Если недоступен — каждый образец обязан быть
 *    «НЕ ПРОВЕРЕНО» с названной причиной, и документ обязан это фиксировать.
 * 4. **Запись в документе** не расходится с живым прогоном (защита от устаревания).
 *
 * # Чего оракул НЕ доказывает
 *
 * Что байты исполнит железо: дизассемблер и исполнение — разные вещи. И что проверены все
 * формы: образцов десять, а реализовано 23 операции.
 */

import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { buildSamples } from './extractE2kSamples';
import {
  ELF_BASE,
  buildE2kElf,
  compareSamples,
  decodeConsoleOutput,
  findExternalTool,
  parseInstructionText,
  parseObjdumpOutput,
  runExternalCheck,
  toWslPath,
  type DisasmLine,
  type ElfLayoutEntry,
} from './e2kExternalObjdump';

const ROOT = path.resolve(__dirname, '..', '..');
const DOC = path.join(ROOT, 'docs', 'e2k-external-validation.md');

/** Вывод MCST-дизассемблера — как он выглядит на самом деле (адрес без байтов, текст ниже). */
const REAL_OUTPUT = [
  '',
  '/tmp/x.elf:     file format elf64-e2k',
  '',
  '',
  'Disassembly of section .text:',
  '',
  '0000000000100000 <.text>:',
  '  100000:\t',
  '  adds,0 %b[1], %b[2], %b[3]',
  '',
  '  100008:\t',
  '  nop',
  '',
  '  100070:\t',
  '  muls,1 %b[1], %b[2], %b[3]',
  '',
].join('\n');

describe('внешняя проверка: упаковка образцов в ELF', () => {
  const samples = buildSamples();
  const elf = buildE2kElf(samples);

  it('ELF: EM_E2K = 175, машина 8c в e_flags, секция .text на месте', () => {
    const header = elf.bytes;
    expect(header.subarray(0, 4).toString('latin1')).toBe('\u007fELF');
    expect(header[4]).toBe(2); // ELFCLASS64
    expect(header.readUInt16LE(18)).toBe(175); // e_machine
    expect(header.readUInt32LE(48)).toBe(19 << 24); // e_flags: bfd_mach_e2k_8c
    const shoff = Number(header.readBigUInt64LE(40));
    expect(shoff).toBeGreaterThan(0);
    // Таблица секций: [0] пустая, [1] .text, [2] .shstrtab (`\0.text\0.shstrtab\0`).
    expect(header.readUInt32LE(shoff)).toBe(0);
    expect(header.readUInt32LE(shoff + 64)).toBe(1); // имя «.text» — со смещения 1 в shstrtab
    expect(header.readUInt32LE(shoff + 64 + 4)).toBe(1); // SHT_PROGBITS
    expect(header.readUInt32LE(shoff + 128)).toBe(7); // имя «.shstrtab»
    expect(header.readUInt32LE(shoff + 128 + 4)).toBe(3); // SHT_STRTAB
    expect(Number(header.readBigUInt64LE(shoff + 64 + 32))).toBe(
      elf.layout.reduce((sum, entry) => sum + entry.size, 0) + paddingOf(elf.layout),
    );
  });

  it('раскладка: адреса подряд, размеры и операнды совпадают с образцами', () => {
    expect(elf.layout.length).toBe(samples.length);
    elf.layout.forEach((entry, index) => {
      const sample = samples[index]!;
      expect(entry.key).toBe(`${sample.mnemonic},${sample.channel}`);
      expect(entry.size).toBe(sample.size);
      expect(entry.operands).toEqual(sample.operands.map((operand) => (operand.kind === 'reg' ? operand.index : 0)));
      if (index > 0) {
        // Предыдущий образец выровнен до 16 байт
        expect(entry.address).toBe(elf.layout[index - 1]!.address + 16);
      }
    });
    expect(elf.layout[0]!.address).toBe(ELF_BASE);
  });
});

describe('внешняя проверка: разбор вывода дизассемблера', () => {
  it('строки с адресом без байтов и текст на следующей строке разбираются', () => {
    const lines = parseObjdumpOutput(REAL_OUTPUT);
    expect(lines.map((line) => line.address)).toEqual([0x100000, 0x100008, 0x100070]);
    expect(lines[0]!.text).toBe('adds,0 %b[1], %b[2], %b[3]');
    expect(lines[1]!.text).toBe('nop');
  });

  it('текст инструкции разбирается: мнемоника, канал, номера операндов', () => {
    expect(parseInstructionText('adds,0 %b[1], %b[2], %b[3]')).toEqual({
      mnemonic: 'adds',
      channel: 0,
      operands: [1, 2, 3],
    });
    expect(parseInstructionText('movtd,4 %db[1], %db[2]')).toEqual({
      mnemonic: 'movtd',
      channel: 4,
      operands: [1, 2],
    });
    expect(parseInstructionText('adds,7 %r5, %r6, %r7')).toEqual({
      mnemonic: 'adds',
      channel: 7,
      operands: [5, 6, 7],
    });
    expect(parseInstructionText('nop')).toBeUndefined();
    expect(parseInstructionText('')).toBeUndefined();
  });

  it('вывод wsl.exe декодируется: UTF-16LE не превращается в пустоту', () => {
    const text = '  100000:\n  adds,0 %b[1]\n';
    const utf16 = Buffer.from(text, 'utf16le');
    expect(decodeConsoleOutput(utf16)).toContain('adds,0');
    expect(decodeConsoleOutput(Buffer.from(text, 'utf-8'))).toContain('adds,0');
  });

  it('путь к ELF переводится в путь WSL', () => {
    expect(toWslPath('D:\\PROJECTS\\OSNOVA-FABRIKA\\.tmp\\e2k-samples.elf')).toBe(
      '/mnt/d/PROJECTS/OSNOVA-FABRIKA/.tmp/e2k-samples.elf',
    );
  });

  it('негативный контроль: чужая мнемоника, канал и операнды ловятся, отсутствие строки — тоже', () => {
    const layout: ElfLayoutEntry[] = [
      { key: 'adds,0', address: 0x100000, size: 8, mnemonic: 'adds', channel: 0, form: 'ALF1', operands: [1, 2, 3] },
    ];
    const matched: DisasmLine[] = [{ address: 0x100000, bytes: '', text: 'adds,0 %b[1], %b[2], %b[3]' }];
    expect(compareSamples(layout, matched)[0]!.status).toBe('совпал');

    const wrongMnemonic: DisasmLine[] = [{ address: 0x100000, bytes: '', text: 'subs,0 %b[1], %b[2], %b[3]' }];
    const mnemonicResult = compareSamples(layout, wrongMnemonic)[0]!;
    expect(mnemonicResult.status).toBe('не совпал');
    expect(mnemonicResult.reason).toMatch(/мнемоника/);

    const wrongChannel: DisasmLine[] = [{ address: 0x100000, bytes: '', text: 'adds,5 %b[1], %b[2], %b[3]' }];
    expect(compareSamples(layout, wrongChannel)[0]!.reason).toMatch(/канал/);

    const wrongOperands: DisasmLine[] = [{ address: 0x100000, bytes: '', text: 'adds,0 %b[1], %b[2], %b[7]' }];
    expect(compareSamples(layout, wrongOperands)[0]!.reason).toMatch(/операнды/);

    expect(compareSamples(layout, [])[0]!.status).toBe('НЕ ПРОВЕРЕНО');
    expect(compareSamples(layout, [])[0]!.reason).toMatch(/не напечатал строку/);

    const unparsable: DisasmLine[] = [{ address: 0x100000, bytes: '', text: 'что-то непонятное' }];
    expect(compareSamples(layout, unparsable)[0]!.reason).toMatch(/не удалось разобрать/);
  });
});

describe('внешняя проверка: живой прогон и запись в документе', () => {
  const doc = fs.existsSync(DOC) ? fs.readFileSync(DOC, 'utf-8') : '';
  const { tool, reason } = findExternalTool();

  it('внешний дизассемблер либо найден, либо причина названа', () => {
    if (tool === undefined) {
      expect(reason, 'причина ненайденности не названа').toBeDefined();
      expect(reason!.length).toBeGreaterThan(30);
      expect(doc, 'документ не фиксирует, что внешней проверки не было').toMatch(
        /НЕ ПРОВЕРЕНО|дизассемблер e2k не найден/,
      );
      return;
    }
    expect(tool.version).toMatch(/objdump/i);
    expect(tool.origin.length).toBeGreaterThan(5);
  });

  it('каждый образец либо совпал с дизассемблером, либо помечен «НЕ ПРОВЕРЕНО»', () => {
    const report = runExternalCheck();
    expect(report.comparisons.length).toBeGreaterThanOrEqual(5);
    const withoutStatus = report.comparisons.filter((item) => !['совпал', 'не совпал', 'НЕ ПРОВЕРЕНО'].includes(item.status));
    expect(withoutStatus).toEqual([]);
    for (const item of report.comparisons) {
      if (item.status === 'НЕ ПРОВЕРЕНО') expect(item.reason.length).toBeGreaterThan(20);
    }
    if (report.tool === null) {
      expect(report.summary.unverified).toBe(report.comparisons.length);
      return;
    }
    // Дизассемблер найден: расхождений быть не должно, и это записано в документе.
    expect(report.summary.mismatched, JSON.stringify(report.comparisons.filter((i) => i.status === 'не совпал'))).toBe(0);
    expect(report.summary.matched).toBe(report.comparisons.length);
    expect(doc).toContain(report.tool.version.split(' ').slice(0, 4).join(' ') || 'objdump');
    expect(doc, 'в документе нет числа совпавших образцов').toMatch(/10 (образцов )?из 10|совпало 10/);
  });

  it('документ описывает имена регистров: дизассемблер печатает %b[N] там, где у нас %rN', () => {
    // Это находка внешней проверки: имя файла регистров — вопрос обозначения, а не кодировки.
    if (tool === undefined) return;
    expect(doc).toContain('%b[');
  });
});

/** Суммарное выравнивание образцов до 16 байт. */
function paddingOf(layout: readonly ElfLayoutEntry[]): number {
  return layout.reduce((sum, entry) => sum + ((16 - (entry.size % 16)) % 16), 0);
}
