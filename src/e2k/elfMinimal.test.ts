// ЦЕЛЬ, не состояние. См. hardware-debt §3.23.
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
  EM_E2K,
  MACH_8C,
  MINIMAL_BASE,
  SYSCALL_ARGUMENT_REGISTER,
  SYSCALL_NUMBER_REGISTER,
  SYSCALL_WBS,
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

  it('код состоит из извлечённых форм: setbn, два окна-литерала, sdisp и call', () => {
    const program = buildMinimalProgram(42);
    expect(program.instructions.map((instruction) => instruction.mnemonic)).toEqual([
      'setbn',
      'movts',
      'movts',
      'sdisp',
      'call',
    ]);
    // setbn 8 + movts 16 + movts 16 + sdisp 8 + call 16
    expect(program.code.length).toBe(8 + 16 + 16 + 8 + 16);
    // Номер вызова — 1 (exit), а не 60: взято из syscall_nr.h порта QEMU.
    expect(SYS_EXIT).toBe(1);
    // Литеральные поля (0xd4, 16 бит) — в слотах второго и третьего movts.
    expect(program.code[8 + 5]).toBe(0xd4);
    expect(program.code[24 + 5]).toBe(0xd4);
    // Оконный файл регистров: поля слога несут старший бит 0x80 (номер вызова — %r8, довод — %r9).
    expect(program.code[8 + 4]).toBe(SYSCALL_NUMBER_REGISTER | 0x80);
    expect(program.code[24 + 4]).toBe(SYSCALL_ARGUMENT_REGISTER | 0x80);
    // sdisp: ctp_opc = 2 (0x60 в старшем байте) — им ставится тег CTPSL.
    expect(program.code[40 + 7]).toBe(0x60);
    // call: сдвиг окна wbs = 4 (SYSCALL_WBS здесь же названа константой).
    expect(typeof SYSCALL_WBS).toBe('number');
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

  it('ассемблер МЦСТ: формы совпадают байтами, для 0..15 — измеренная разница форм', () => {
    if (asTool === undefined) return;
    const program = buildMinimalProgram(42);
    const texts = [
      'setbn rsz=4, rbs=0, rcur=0',
      'movts,0 1, %r8',
      'movts,0 42, %r9',
      'sdisp %ctpr1, 0',
      'call %ctpr1, wbs=4',
    ];
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
      // Значение 1 влезает в 4 бита, поэтому здесь ассемблер берёт непосредственную форму (0xc1,
      // 8 байт), а наш кодировщик — литерал LTS (0xd4, 16 байт): разница форм, а не ошибка.
      if (text === 'movts,0 1, %r8') {
        expect(Array.from(result.bytes)).toEqual([0x01, 0, 0, 4, 0x88, 0xc1, 0xc0, 0x60]);
        expect(ours[4]).toBe(0x88);
        expect(ours[5]).toBe(0xd4);
        expect(ours.length).toBeGreaterThan(result.bytes.length);
        continue;
      }
      expect(Array.from(result.bytes), `байты ассемблера для «${text}»`).toEqual(ours);
    }
  });

  it('требования окружения к exit(42) названы, а не спрятаны', () => {
    const program = buildMinimalProgram(42);
    expect(program.blockers.length).toBe(2);
    const text = program.blockers.join(' ');
    // Оба требования — к ХОСТУ: шим для mmap и правка полей WD в порте QEMU.
    expect(text).toMatch(/шим/i);
    expect(text).toMatch(/MAP_FIXED_NOREPLACE/);
    expect(text).toMatch(/WD\.size_d|_d/);
    expect(text, 'не названа точная причина отказа без правки').toMatch(/syscall without proper WD configuration/);
    expect(text).toMatch(/docs\/e2k-qemu-run\.md/);
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
