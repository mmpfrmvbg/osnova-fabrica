/**
 * МИНИМАЛЬНЫЙ ELF ДЛЯ e2k: `_start`, который должен был бы сделать `exit(42)`.
 *
 * # Зачем
 *
 * Прогон в QEMU (`docs/e2k-qemu-run.md`) упирался в две вещи: **нечем** запускать (QEMU не был
 * собран) и **нечего** запускать (у конвейера нет e2k-бинарника). Первое снято — `qemu-e2k`
 * собран. Здесь делается второе: минимальный ELF64 с `e_machine = 175`, секцией `.text`
 * и точкой входа, чтобы у QEMU было что загрузить.
 *
 * # Что в коде
 *
 * | шаг | инструкция | состояние |
 * |---|---|---|
 * | номер системного вызова | литерал в регистр (`movts` с LTS) | **кодируется** |
 * | аргумент (42) | литерал в регистр (`movts` с LTS) | **кодируется** |
 * | передача управления | `ct %ctpr1` (SS) | **кодируется** |
 *
 * Номер системного вызова — **1** (`exit`), не 60: числа берутся из порта QEMU
 * (`qemu/linux-user/e2k/syscall_nr.h:9` — `TARGET_NR_exit 1`; `:293` — `TARGET_NR_exit_group 300`).
 *
 * # Что мешает этому быть настоящим `exit(42)` — два препятствия, оба названы
 *
 * 1. **Файл регистров.** ABI системных вызовов e2k берёт номер вызова из **оконного** регистра
 *    `r0`, а аргументы — из `r1`…`r8` (`qemu/linux-user/e2k/cpu_loop.c:160-182`). Это **рабочий**
 *    файл регистров: в поле слога ему соответствует `0x80 | N` (`opcodes/e2k-dis.c:418-419`,
 *    `%rN`), тогда как интерфейс `Operand` несёт только номер, то есть **базовый** файл
 *    (`0x00 | N`, `%b[N]`). Значит этим ELF'ом номер вызова кладётся не в тот регистр.
 * 2. **Сам системный вызов.** QEMU выполняет вызов, когда передача управления идёт на `%ctpr`
 *    с тегом `CTPSL` (`qemu/target/e2k/tcg/translate-ct.c:1143-1145`), а тег ставит подготовка
 *    перехода (`translate-ctp.c:174`). **Как записать эту подготовку ассемблером МЦСТ, в
 *    источниках не найдено:** мнемоник `syscall`/`ctpsl` в таблице опкодов нет, `ipush`
 *    ассемблер отвергает («unknown instruction»), а `ct` тег не ставит. Поэтому вместо вызова
 *    здесь стоит обычная передача управления — программа **не завершится кодом 42**.
 *
 * Отсюда честный статус: **ELF валиден по заголовку и разбирается дизассемблером МЦСТ, но
 * `exit(42)` им не выполняется**, и причина названа выше, а не спрятана.
 */

import * as fs from 'fs';
import * as path from 'path';
import type { AsmInstruction, Operand } from './backend';
import { getEncoder } from './backend';
import { CT_COND_ALWAYS } from './e2k-real';

const ROOT = path.resolve(__dirname, "..", "..");

/** Базовый адрес загрузки — НАШЕ РЕШЕНИЕ (у загрузчика linux-user он свободный). */
export const MINIMAL_BASE = 0x100000;

/** `e_machine = 175` — `EM_E2K` (`qemu/include/elf.h:195`) = `EM_MCST_ELBRUS` (`binutils-gdb/include/elf/common.h:295`). */
export const EM_E2K = 175;

/** Номер машины в `e_flags` (`binutils-gdb/include/elf/e2k.h:114-115`): `bfd_mach_e2k_8c = 19`. */
export const MACH_8C = 19;

/** Номер системного вызова `exit` в e2k Linux — `qemu/linux-user/e2k/syscall_nr.h:9`. */
export const SYS_EXIT = 1;

/** Регистр, из которого e2k-порт QEMU читает номер вызова (`cpu_loop.c:166`). */
export const ABI_NUMBER_REGISTER = 'r0';

const imm = (value: number): Operand => ({ kind: 'imm', value });
const reg = (index: number): Operand => ({ kind: 'reg', index });

/** Программа минимального ELF: инструкции и текст, который должен получиться у дизассемблера. */
export interface MinimalProgram {
  readonly instructions: readonly AsmInstruction[];
  readonly code: Uint8Array;
  /** Что обязан напечатать `objdump` для каждой инструкции. */
  readonly expectDisasm: readonly string[];
  /** Что мешает программе быть настоящим `exit(42)`. */
  readonly blockers: readonly string[];
}

/**
 * Собрать программу минимального ELF.
 *
 * Операции идут через LTS-литералы (`movts` с `imm`) и слог SS (`ct`) — обе формы извлечены и
 * сверены с ассемблером МЦСТ (`docs/e2k-syllables-real.md`).
 */
export function buildMinimalProgram(exitCode = 42): MinimalProgram {
  const encoder = getEncoder('e2k');
  const instructions: AsmInstruction[] = [
    { mnemonic: 'movts', channel: 0, operands: [imm(SYS_EXIT), reg(0)] },
    { mnemonic: 'movts', channel: 0, operands: [imm(exitCode), reg(1)] },
    { mnemonic: 'ct', channel: 0, operands: [imm(1), imm(CT_COND_ALWAYS)] },
  ];
  const chunks = instructions.map((instruction) => encoder.encode(instruction));
  const code = new Uint8Array(chunks.reduce((sum, chunk) => sum + chunk.length, 0));
  let offset = 0;
  for (const chunk of chunks) {
    code.set(chunk, offset);
    offset += chunk.length;
  }
  return {
    instructions,
    code,
    expectDisasm: ['movts,0 _f16s 0x1', `movts,0 _f16s 0x${exitCode.toString(16)}`, 'ct %ctpr1'],
    blockers: [
      `ABI: номер вызова e2k читается из оконного регистра ${ABI_NUMBER_REGISTER} ` +
        '(qemu/linux-user/e2k/cpu_loop.c:160-182), а интерфейс Operand несёт только базовый файл ' +
        '(поле 0x00|N = %b[N], opcodes/e2k-dis.c:416-417); рабочий файл (0x80|N = %rN, :418-419) ' +
        'интерфейсом не выражается — номер вызова ложится не в тот регистр',
      'вызов: QEMU выполняет системный вызов только при передаче управления на %ctpr с тегом CTPSL ' +
        '(qemu/target/e2k/tcg/translate-ct.c:1143-1145), а как эту подготовку записать ассемблером МЦСТ — ' +
        'НЕТ В ИСТОЧНИКЕ (мнемоник syscall/ctpsl в таблице опкодов нет, ipush ассемблер отвергает)',
    ],
  };
}

/** Собранный ELF: байты и что в нём лежит. */
export interface MinimalElf {
  readonly bytes: Uint8Array;
  readonly entry: number;
  readonly program: MinimalProgram;
  readonly sections: readonly { readonly name: string; readonly offset: number; readonly size: number }[];
}

function align(value: number, to: number): number {
  return Math.ceil(value / to) * to;
}

/**
 * Собрать ELF64 с `_start`: заголовок, один сегмент `PT_LOAD`, секции `.text`, `.symtab`,
 * `.strtab`, `.shstrtab`.
 *
 * Заголовки — ровно те, что нужны загрузчику: `ELFCLASS64`, `ELFDATA2LSB`, `e_machine = 175`,
 * `e_entry` в начале `.text`, `PT_LOAD` с флагами `R|X`.
 */
export function buildMinimalElf(exitCode = 42, base = MINIMAL_BASE): MinimalElf {
  const program = buildMinimalProgram(exitCode);
  const textOffset = 0x1000;
  const sections: { name: string; offset: number; size: number }[] = [];

  // .text
  const text = program.code;
  sections.push({ name: '.text', offset: textOffset, size: text.length });

  // .symtab: одна запись — `_start` в начале .text
  const strtab = Buffer.from('\u0000_start\u0000', 'latin1');
  const symtabOffset = align(textOffset + text.length, 8);
  const symbol = Buffer.alloc(24);
  symbol.writeUInt32LE(1, 0); // st_name = 1 (после начального NUL)
  symbol.writeUInt8(0x12, 4); // STB_GLOBAL | STT_FUNC
  symbol.writeUInt8(0, 5); // st_other
  symbol.writeUInt16LE(1, 6); // st_shndx = 1 (.text)
  symbol.writeBigUInt64LE(BigInt(base), 8);
  symbol.writeBigUInt64LE(BigInt(text.length), 16);
  const symtab = Buffer.concat([Buffer.alloc(24), symbol]);
  sections.push({ name: '.symtab', offset: symtabOffset, size: symtab.length });

  // .strtab
  const strtabOffset = symtabOffset + symtab.length;
  sections.push({ name: '.strtab', offset: strtabOffset, size: strtab.length });

  // .shstrtab
  const names = ['\u0000', '.text\u0000', '.symtab\u0000', '.strtab\u0000', '.shstrtab\u0000'];
  const shstr = Buffer.from(names.join(''), 'latin1');
  const shstrOffset = strtabOffset + strtab.length;
  sections.push({ name: '.shstrtab', offset: shstrOffset, size: shstr.length });

  const shoff = align(shstrOffset + shstr.length, 8);
  // Секции: 0 — null, 1 — .text, 2 — .symtab, 3 — .strtab, 4 — .shstrtab.
  const shnum = 5;
  const file = Buffer.alloc(shoff + shnum * 64);

  // ELF-заголовок
  file[0] = 0x7f;
  file.write('ELF', 1, 'latin1');
  file[4] = 2; // ELFCLASS64
  file[5] = 1; // ELFDATA2LSB
  file[6] = 1; // EV_CURRENT
  file.writeUInt16LE(2, 16); // ET_EXEC
  file.writeUInt16LE(EM_E2K, 18);
  file.writeUInt32LE(1, 20);
  file.writeBigUInt64LE(BigInt(base), 24); // e_entry
  file.writeBigUInt64LE(0x40n, 32); // e_phoff
  file.writeBigUInt64LE(BigInt(shoff), 40);
  file.writeUInt32LE(MACH_8C << 24, 48); // e_flags
  file.writeUInt16LE(64, 52);
  file.writeUInt16LE(56, 54);
  file.writeUInt16LE(1, 56);
  file.writeUInt16LE(64, 58);
  file.writeUInt16LE(shnum, 60);
  file.writeUInt16LE(4, 62); // e_shstrndx = индекс .shstrtab (4 из 5 секций)

  // Заголовок программы: PT_LOAD, R|X, весь образ одним сегментом
  const segmentSize = shstrOffset + shstr.length - textOffset;
  file.writeUInt32LE(1, 0x40);
  file.writeUInt32LE(5, 0x44);
  file.writeBigUInt64LE(BigInt(textOffset), 0x48);
  file.writeBigUInt64LE(BigInt(base), 0x50);
  file.writeBigUInt64LE(BigInt(base), 0x58);
  file.writeBigUInt64LE(BigInt(segmentSize), 0x60);
  file.writeBigUInt64LE(BigInt(segmentSize), 0x68);
  file.writeBigUInt64LE(0x1000n, 0x70);

  file.set(text, textOffset);
  file.set(symtab, symtabOffset);
  file.set(strtab, strtabOffset);
  file.set(shstr, shstrOffset);

  const sh = (
    at: number,
    name: number,
    type: number,
    flags: bigint,
    addr: bigint,
    offset: number,
    size: number,
    link: number,
    info: number,
    entsize: bigint,
  ): void => {
    file.writeUInt32LE(name, at);
    file.writeUInt32LE(type, at + 4);
    file.writeBigUInt64LE(flags, at + 8);
    file.writeBigUInt64LE(addr, at + 16);
    file.writeBigUInt64LE(BigInt(offset), at + 24);
    file.writeBigUInt64LE(BigInt(size), at + 32);
    file.writeUInt32LE(link, at + 40);
    file.writeUInt32LE(info, at + 44);
    file.writeBigUInt64LE(8n, at + 48);
    file.writeBigUInt64LE(entsize, at + 56);
  };
  sh(shoff, 0, 0, 0n, 0n, 0, 0, 0, 0, 0n);
  sh(shoff + 64, 1, 1, 6n, BigInt(base), textOffset, text.length, 0, 0, 0n);
  sh(shoff + 128, 7, 2, 0n, 0n, symtabOffset, symtab.length, 3, 1, 24n);
  sh(shoff + 192, 15, 3, 0n, 0n, strtabOffset, strtab.length, 0, 0, 0n);
  sh(shoff + 256, 23, 3, 0n, 0n, shstrOffset, shstr.length, 0, 0, 0n);

  return { bytes: new Uint8Array(file), entry: base, program, sections };
}

/** Записать минимальный ELF в `.tmp` и вернуть путь. */
export function writeMinimalElf(file = path.join(ROOT, '.tmp', 'e2k-minimal.elf'), exitCode = 42): string {
  const elf = buildMinimalElf(exitCode);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, elf.bytes);
  return file;
}

/** Разбор заголовка ELF — тем же способом, что и в оракуле: без внешних инструментов. */
export interface ElfHeader {
  readonly magic: string;
  readonly elfClass: number;
  readonly data: number;
  readonly type: number;
  readonly machine: number;
  readonly entry: number;
  readonly flags: number;
  readonly phoff: number;
  readonly shoff: number;
  readonly shnum: number;
  readonly shstrndx: number;
}

/** Прочитать заголовок ELF64. */
export function readElfHeader(bytes: Uint8Array): ElfHeader {
  if (bytes.length < 64) throw new Error(`файл короче заголовка ELF64: ${bytes.length} байт`);
  const buffer = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return {
    magic: buffer.subarray(0, 4).toString('latin1'),
    elfClass: buffer[4]!,
    data: buffer[5]!,
    type: buffer.readUInt16LE(16),
    machine: buffer.readUInt16LE(18),
    entry: Number(buffer.readBigUInt64LE(24)),
    phoff: Number(buffer.readBigUInt64LE(32)),
    shoff: Number(buffer.readBigUInt64LE(40)),
    flags: buffer.readUInt32LE(48),
    shnum: buffer.readUInt16LE(60),
    shstrndx: buffer.readUInt16LE(62),
  };
}

function main(): void {
  const file = writeMinimalElf();
  const elf = buildMinimalElf();
  const header = readElfHeader(elf.bytes);
  console.log(`записано: ${path.relative(ROOT, file)} (${elf.bytes.length} байт)`);
  console.log(
    `заголовок: magic=${header.magic} class=${header.elfClass} data=${header.data} ` +
      `machine=${header.machine} entry=0x${header.entry.toString(16)} flags=0x${header.flags.toString(16)}`,
  );
  console.log(`код: ${elf.program.code.length} байт, инструкций ${elf.program.instructions.length}`);
  for (const blocker of elf.program.blockers) console.log(`препятствие: ${blocker}`);
}

if (require.main === module) {
  main();
}
