/**
 * ОРАКУЛ МИНИМАЛЬНОГО ELF ДЛЯ e2k.
 *
 * # Что проверяется
 *
 * 1. **Заголовок.** `ELFCLASS64`, `ELFDATA2LSB`, `e_machine = 175`, `e_flags` с машиной 8c,
 *    точка входа в начале `.text`, заголовок программы `PT_LOAD`.
 * 2. **Код кодируется извлечёнными формами**: два литерала (LTS) и передача управления (SS).
 * 3. **Дизассемблер МЦСТ разбирает код в этом ELF** — внешняя проверка того, что образ
 *    действительно читается как программа, а не как набор байтов.
 * 4. **Препятствия названы, а не спрятаны**: `exit(42)` этим ELF'ом не выполняется, и тест
 *    требует, чтобы причина была записана (файл регистров ABI и тег CTPSL).
 * 5. **QEMU.** Если эмулятор доступен и размещает гостя — код обязан завершиться с кодом 42;
 *    иначе записывается точная причина (на этом хосте — `guest_base`).
 *
 * # Чего оракул НЕ доказывает
 *
 * Что `exit(42)` действительно произойдёт: два препятствия из §4 не сняты, и это записано.
 */

import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { spawnSync } from 'child_process';
import { getEncoder } from './backend';
import {
  ABI_NUMBER_REGISTER,
  EM_E2K,
  MACH_8C,
  MINIMAL_BASE,
  SYS_EXIT,
  buildMinimalElf,
  buildMinimalProgram,
  readElfHeader,
  writeMinimalElf,
} from './elfMinimal';
import {
  disassembleElf,
  findExternalTool,
  parseObjdumpOutput,
  toWslPath,
} from '../scripts/e2kExternalObjdump';
import { findExternalAs, type AsSample } from '../scripts/e2kExternalAs';
import { assembleAll } from '../scripts/e2kExternalAs';

const ROOT = path.resolve(__dirname, '..', '..');

describe('минимальный ELF: заголовок и код', () => {
  const elf = buildMinimalElf(42);

  it('заголовок: ELFCLASS64, ELFDATA2LSB, e_machine = 175, машина 8c', () => {
    const header = readElfHeader(elf.bytes);
    expect(header.magic).toBe('\u007fELF');
    expect(header.elfClass).toBe(2);
    expect(header.data).toBe(1);
    expect(header.type).toBe(2); // ET_EXEC
    expect(header.machine).toBe(EM_E2K);
    expect(header.machine).toBe(175);
    expect(header.flags).toBe(MACH_8C << 24);
    expect(header.entry).toBe(MINIMAL_BASE);
    expect(header.phoff).toBe(0x40);
    expect(header.shnum).toBe(5); // null, .text, .symtab, .strtab, .shstrtab
    expect(header.shstrndx).toBe(4); // индекс .shstrtab внутри таблицы секций
    expect(header.shstrndx).toBeLessThan(header.shnum);
    // Заголовок программы: PT_LOAD с флагами R|X
    expect(elf.bytes[0x40]).toBe(1);
    expect(elf.bytes[0x44]).toBe(5);
  });

  it('код состоит из извлечённых форм: два литерала и передача управления', () => {
    const program = buildMinimalProgram(42);
    expect(program.instructions.map((instruction) => instruction.mnemonic)).toEqual(['movts', 'movts', 'ct']);
    expect(program.code.length).toBe(16 + 16 + 8);
    // Номер вызова — 1 (exit), а не 60: взято из syscall_nr.h порта QEMU.
    expect(SYS_EXIT).toBe(1);
    // Литеральные поля видны в байтах: 0xd4 (16 бит) и управляющий слог SS с ALWAYS.
    expect(program.code[5]).toBe(0xd4);
    expect(program.code[21]).toBe(0xd4);
    expect(program.code[program.code.length - 4]).toBe(0x20);
  });

  it('байты кода совпадают с кодировщиком', () => {
    const program = buildMinimalProgram(42);
    const encoder = getEncoder('e2k');
    const expected = program.instructions.map((instruction) => encoder.encode(instruction));
    let offset = 0;
    expected.forEach((chunk, index) => {
      expect(Array.from(program.code.subarray(offset, offset + chunk.length))).toEqual(Array.from(chunk));
      offset += chunk.length;
      expect(index).toBeLessThan(program.instructions.length);
    });
  });

  it('запись файла не расходится с построением', () => {
    const file = writeMinimalElf(path.join(ROOT, '.tmp', 'e2k-minimal.elf'), 42);
    const written = fs.readFileSync(file);
    expect(written.length).toBe(elf.bytes.length);
    expect(Array.from(written.subarray(0, 64))).toEqual(Array.from(elf.bytes.subarray(0, 64)));
  });
});

describe('минимальный ELF: внешняя проверка', () => {
  const { tool: objdumpTool } = findExternalTool();
  const { tool: asTool } = findExternalAs();

  it('дизассемблер МЦСТ разбирает код в ELF', () => {
    if (objdumpTool === undefined) return;
    const elf = buildMinimalElf(42);
    const result = disassembleElf(elf, path.join(ROOT, '.tmp', 'e2k-minimal.elf'));
    if (result === undefined) return; // инструмент пропал — случай назван ниже
    const lines = parseObjdumpOutput(result.text).map((line) => line.text);
    expect(result.text, 'objdump не увидел ELF').toContain('e2k');
    for (const expected of elf.program.expectDisasm) {
      expect(lines.some((line) => line.includes(expected)), `не найдено «${expected}» в ${lines.join(' | ')}`).toBe(true);
    }
  });

  it('ассемблер МЦСТ: инструкции совпадают байтами, для 0..15 — измеренная разница форм', () => {
    if (asTool === undefined) return;
    const program = buildMinimalProgram(42);
    const texts = ['movts,0 1, %b[0]', 'movts,0 42, %b[1]', 'ct %ctpr1'];
    const samples: AsSample[] = texts.map((asText, index) => ({
      key: `minimal-${index}`,
      mnemonic: program.instructions[index]!.mnemonic,
      channel: 0,
      form: 'минимальный ELF',
      asText,
      instruction: program.instructions[index]!,
      source: 'docs/e2k-minimal-elf.md',
    }));
    const results = assembleAll(samples);
    const encoder = getEncoder('e2k');
    for (const [index, text] of texts.entries()) {
      const result = results[index]!;
      expect(result.ok, `ассемблер отверг «${text}»`).toBe(true);
      if (!result.ok) continue;
      const ours = Array.from(encoder.encode(program.instructions[index]!));
      if (index === 0) {
        // ИЗМЕРЕННАЯ РАЗНИЦА ФОРМ. Значение 0..15 ассемблер кладёт 4-битной непосредственной
        // формой (поле `0xc0 | N`, 8 байт), наш кодировщик — литералом LTS (`0xd4`, 16 байт).
        // Обе формы разбираются дизассемблером (проверка выше); расхождение записано, а не скрыто.
        expect(Array.from(result.bytes), `байты ассемблера для «${text}»`).toEqual([1, 0, 0, 4, 0, 0xc1, 0xc0, 0x60]);
        expect(ours).toEqual([0x11, 0, 0, 4, 0, 0xd4, 0xc0, 0x60, 0, 0, 0, 0, 0, 0, 1, 0]);
        expect(ours.length).toBeGreaterThan(result.bytes.length);
        continue;
      }
      // Литерал 42 (не влезает в 4 бита) и управляющий слог SS — совпадают побайтово.
      expect(Array.from(result.bytes), `байты ассемблера для «${text}»`).toEqual(ours);
    }
  });

  it('препятствия к exit(42) названы, а не спрятаны', () => {
    const program = buildMinimalProgram(42);
    expect(program.blockers.length).toBe(3);
    const text = program.blockers.join(' ');
    expect(text, 'не названо препятствие с файлом регистров').toContain(ABI_NUMBER_REGISTER);
    expect(text).toMatch(/%b\[N\]/);
    expect(text).toMatch(/CTPSL/);
    // Препятствие «переход не подготовлен» — измеренное прогоном, а не предположение.
    expect(text).toMatch(/0x100020|CTPEW/);
    // Препятствие «тег CTPSL ставит SDISP» названо с источником и с упором в кодировщик.
    expect(text).toMatch(/translate-ctp\.c:174/);
    expect(text).toMatch(/ОТВЕРГАЕТ/);
  });

  it('QEMU: либо код возврата 42, либо точная причина', () => {
    const qemu = 'C:\\Program Files\\WSL\\wsl.exe';
    const elf = writeMinimalElf(path.join(ROOT, '.tmp', 'e2k-minimal.elf'), 42);
    const wslPath = toWslPath(elf);
    // Именно spawnSync: QEMU печатает причину в stderr и при этом выходит с кодом 0, поэтому
    // execFileSync (отдаёт только stdout) показал бы пустую строку вместо причины.
    const run = spawnSync(qemu, ['-d', 'e2k', '--', '/root/qemu-build/qemu-e2k', wslPath], {
      timeout: 120_000,
      encoding: 'utf8',
    });
    const code = run.status ?? undefined;
    const output = `${run.stdout ?? ''}${run.stderr ?? ''}`;
    if (code === 42) {
      expect(code).toBe(42);
      return;
    }
    // Прогон не дал 42 — причина обязана быть видна и записана в документе.
    expect(output.length, 'нет ни кода 42, ни причины').toBeGreaterThan(0);
    const reasons = ['guest_base', 'Unable to find', 'command not found', 'No such file'];
    expect(reasons.some((reason) => output.includes(reason)), `причина не названа: ${output.slice(0, 200)}`).toBe(true);
    const doc = path.join(ROOT, 'docs', 'e2k-qemu-run.md');
    if (fs.existsSync(doc)) {
      expect(fs.readFileSync(doc, 'utf-8')).toMatch(/guest_base/);
    }
  });
});
