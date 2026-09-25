/**
 * МИНИМАЛЬНЫЙ ELF ДЛЯ e2k: `_start`, который делает `exit(42)`.
 *
 * # Зачем
 *
 * Прогон в QEMU (`docs/e2k-qemu-run.md`) упирался в две вещи: **нечем** запускать (QEMU не был
 * собран) и **нечего** запускать (у конвейера нет e2k-бинарника). Первое снято — `qemu-e2k`
 * собран. Здесь делается второе: минимальный ELF64 с `e_machine = 175`, секцией `.text`
 * и точкой входа.
 *
 * # Статус: `exit(42)` ВЫПОЛНЕН
 *
 * Прогон с шимом для `mmap` даёт **код возврата 42** (`docs/e2k-minimal-elf.md` §7). Программа —
 * пять инструкций, и каждая форма извлечена из источников и сверена ассемблером МЦСТ:
 * `setbn` (CS1, окно вращаемых регистров), `movts` с литералом LTS в **оконные** `%r8`/`%r9`,
 * `sdisp` (CS0 с `ctp_opc = 2`, ставит тег `CTPSL`), `call` (CS1, `wbs=4`).
 *
 * Номер системного вызова — **1** (`exit`), не 60: числа берутся из порта QEMU
 * (`qemu/linux-user/e2k/syscall_nr.h:9` — `TARGET_NR_exit 1`; `:293` — `TARGET_NR_exit_group 300`).
 *
 * # Чем это далось — две послабления со стороны ХОСТА, не программы
 *
 * 1. **Шим для `mmap`**: WSL1 не знает `MAP_FIXED_NOREPLACE` (`errno=95`), на котором стоит поиск
 *    гостевого резерва (`linux-user/elfload.c:792`), поэтому QEMU не размещает гостя вовсе.
 * 2. **Правка порта QEMU**: поля `WD.size_d/base_d` порт только читает
 *    (`reg-index.h:64-79`, `translate-ct.c:71-73`), а сам строит `WD` из `_q`-полей; без правки
 *    системный вызов умирает на чтении номера из оконного `r0` — «syscall without proper WD
 *    configuration» (`cpu_loop.c:164-169`).
 *
 * Оба послабления — на стороне хоста; байты ELF при этом не меняются, и без них тот же ELF
 * останавливается с названной причиной, а не «работает иначе».
 */

import * as fs from 'fs';
import * as path from 'path';
import type { AsmInstruction, Operand } from './backend';
import { getEncoder } from './backend';

const ROOT = path.resolve(__dirname, "..", "..");

/** Базовый адрес загрузки — НАШЕ РЕШЕНИЕ (у загрузчика linux-user он свободный). */
export const MINIMAL_BASE = 0x100000;

/**
 * Хвост образа: `extraMemory` сегмента кода, байт. В его начале встаёт **куча** рантайма массивов
 * (`src/e2k/arrayRuntime.ts`: `%b[15]` = `MINIMAL_BASE + IMAGE_TAIL_OFFSET`).
 *
 * Величина — не «на глаз»: она равна `HEAP_OFFSET` всех шлюзовых образов (`src/e2k/e2kArraysQemu.test.ts`,
 * `src/e2k/e2kConvolutionQemu.test.ts`), и тем самым адреса, зашитые раскладкой, и адреса, которыми
 * живёт прогон, — одни и те же числа.
 */
export const IMAGE_TAIL_OFFSET = 0x2000;

/**
 * Область слотов вытеснения — **под указателем кучи**, 256 байт (32 слота по 8).
 *
 * Почему под кучей, а не над: куча растёт ВВЕРХ (`создать` и `добавить` двигают `%b[15]`), поэтому
 * всё, что ниже её начала, не будет занято никогда — а место выше кучи она со временем съест. Почему
 * не «в коде»: сегмент образа один, и запись в код испортила бы команды; нижняя граница области
 * поэтому — конец кода, и она названа числом: код шлюзовых образов меньше `IMAGE_TAIL_OFFSET − 256`.
 */
export const SPILL_AREA_BYTES = 0x100;

/** Адрес области слотов вытеснения при данном адресе кучи. */
export function spillBaseOf(heapAddress: number): number {
  return heapAddress - SPILL_AREA_BYTES;
}

/**
 * Адрес области слотов **по умолчанию** — по конвенции образа (куча в начале хвоста).
 *
 * Нужен там, где образ не собирается, а только считается (конвейер `src/e2k/e2kRealRun.ts`,
 * замеры). Размеры команд от значения адреса не зависят: адрес слота кладётся литералом `movtd`
 * (16 байт) при любом значении, поэтому числа конвейера и числа прогона совпадают.
 */
export const DEFAULT_SPILL_BASE = spillBaseOf(MINIMAL_BASE + IMAGE_TAIL_OFFSET);

/** `e_machine = 175` — `EM_E2K` (`qemu/include/elf.h:195`) = `EM_MCST_ELBRUS` (`binutils-gdb/include/elf/common.h:295`). */
export const EM_E2K = 175;

/** Номер машины в `e_flags` (`binutils-gdb/include/elf/e2k.h:114-115`): `bfd_mach_e2k_8c = 19`. */
export const MACH_8C = 19;

/** Номер системного вызова `exit` в e2k Linux — `qemu/linux-user/e2k/syscall_nr.h:9`. */
export const SYS_EXIT = 1;

/** Регистр, из которого e2k-порт QEMU читает номер вызова (`cpu_loop.c:166`). */
export const ABI_NUMBER_REGISTER = 'r0';

/**
 * Сдвиг окна на системном вызове, в квадрословах (`call …, wbs=N`).
 *
 * Требование порта: `psize_q ≤ wbs ≤ size_q` (`translate-ct.c:908-917`), а начальные значения —
 * `psize_q = 4`, `size_q = 8` (`linux-user/e2k/cpu_loop.c:301-303`). Берётся минимальный, чтобы
 * окно после вызова осталось как можно шире.
 */
export const SYSCALL_WBS = 4;

/**
 * Номер регистра, в который кладётся номер вызова, **в окне вызываемого**.
 *
 * ABI читает его как оконный `r0` (`cpu_loop.c:164-170`), а `call` сдвигает окно на `wbs`
 * квадрослов, то есть на `2 * wbs` регистровых единиц (`MAXNR_D = MAXNR_Q * 2`,
 * `target/e2k/cpu.h:58`). Поэтому вызывающий пишет не в `%r0`, а в `%r(2 * wbs + 0)`: у нас это `%r8`.
 */
export const SYSCALL_NUMBER_REGISTER = 2 * SYSCALL_WBS;

/** Регистр аргумента (оконный `r1` вызываемого): `2 * wbs + 1`. */
export const SYSCALL_ARGUMENT_REGISTER = SYSCALL_NUMBER_REGISTER + 1;

/**
 * Размер области вращаемых регистров для `setbn` (`rsz=…`).
 *
 * `rsz = 4` даёт `(rsz + 1) * 2 = 10` доступных регистровых единиц (`e2k_calc_reg_idx_rotatable`,
 * `target/e2k/reg-index.h:30-52`) — этого хватает, чтобы записать `%r8` и `%r9` до вызова.
 */
export const SYSCALL_SETBN_RSZ = 4;

const imm = (value: number): Operand => ({ kind: 'imm', value });
const wreg = (index: number): Operand => ({ kind: 'reg', index, file: 'window' });

/** Программа минимального ELF: инструкции и текст, который должен получиться у дизассемблера. */
export interface MinimalProgram {
  readonly instructions: readonly AsmInstruction[];
  readonly code: Uint8Array;
  /** Что обязан напечатать `objdump` для каждой инструкции. */
  readonly expectDisasm: readonly string[];
  /** Что требуется от **окружения**, чтобы этот ELF действительно сделал `exit(42)`. */
  readonly blockers: readonly string[];
}

/**
 * Собрать программу минимального ELF: `_start`, который делает `exit(42)`.
 *
 * Последовательность собирается из извлечённых и проверенных форм:
 *
 * | шаг | инструкция | зачем |
 * |---|---|---|
 * | 1 | `setbn rsz=4, rbs=0, rcur=0` | окно вращаемых регистров: `%r0`…`%r9` → абсолютные 0…9 |
 * | 2 | `movts,0 1, %r8` | номер вызова `exit` в **оконный** `r0` вызываемого |
 * | 3 | `movts,0 <код>, %r9` | аргумент в оконный `r1` вызываемого |
 * | 4 | `sdisp %ctpr1, 0` | подготовка `%ctpr1` с тегом `CTPSL` — это и есть признак системного вызова |
 * | 5 | `call %ctpr1, wbs=4` | передача управления: с тегом `CTPSL` порт уходит в `do_syscall` |
 *
 * Почему именно так (измерено, а не выведено):
 * `ct` без подготовки — исключение (`translate-ct.c:840-844`), поэтому нужен `disp`/`sdisp`;
 * тег `CTPSL` ставит только `sdisp` (`translate-ctp.c:174`); номер вызова ABI читает из **оконного**
 * `r0` (`cpu_loop.c:164-170`), а `call` сдвигает окно на `wbs`, поэтому запись идёт в `%r8`/`%r9`,
 * и для этого окно вращаемых регистров должно быть расширено `setbn` (`reg-index.h:30-52`).
 *
 * Форма записи значения тоже замерена: 1 влезает в 4 бита и кодируется короткой непосредственной
 * формой (8 байт), 42 — литеральным полем LTS (16 байт). Обе формы сверены с `as` побайтно.
 */
export function buildMinimalProgram(exitCode = 42): MinimalProgram {
  const encoder = getEncoder('e2k');
  const instructions: AsmInstruction[] = [
    { mnemonic: 'setbn', channel: 0, operands: [imm(SYSCALL_SETBN_RSZ), imm(0), imm(0)] },
    { mnemonic: 'movts', channel: 0, operands: [imm(SYS_EXIT), wreg(SYSCALL_NUMBER_REGISTER)] },
    { mnemonic: 'movts', channel: 0, operands: [imm(exitCode), wreg(SYSCALL_ARGUMENT_REGISTER)] },
    { mnemonic: 'sdisp', channel: 0, operands: [imm(1), imm(0)] },
    { mnemonic: 'call', channel: 0, operands: [imm(1), imm(SYSCALL_WBS)] },
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
    expectDisasm: [
      'setbn rbs = 0x0, rsz = 0x4, rcur = 0x0',
      // Короткая непосредственная форма: внешний дизассемблер МЦСТ печатает её без `_f16s`
      // («movts,0 0x1, %r8»), а `_f16s` — признак литерального поля LTS. Обе формы замерены.
      `movts,0 0x${SYS_EXIT.toString(16)}, %r${SYSCALL_NUMBER_REGISTER}`,
      `movts,0 _f16s 0x${exitCode.toString(16)}, %r${SYSCALL_ARGUMENT_REGISTER}`,
      'sdisp %ctpr1',
      'call %ctpr1, wbs = 0x4',
    ],
    blockers: [
      'окружение: на WSL1 нужен шим для mmap (MAP_FIXED_NOREPLACE не поддерживается, errno=95) — ' +
        'без него QEMU не размещает гостя вовсе (docs/e2k-qemu-run.md §2.5, §2.8); ' +
        'это преграда ХОСТА, а не программы',
      'окружение: сборке QEMU нужна правка полей WD.size_d/base_d — порт их только читает ' +
        '(reg-index.h:64-79, translate-ct.c:71-73), а сам строит WD из _q-полей; без правки ' +
        'системный вызов умирает на чтении номера: «syscall without proper WD configuration» ' +
        '(cpu_loop.c:164-169). Замер и текст правки — docs/e2k-qemu-run.md §2.9',
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
  return { ...buildElfFromCode(program.code, base), program };
}

/**
 * Собрать ELF64 вокруг **произвольного** кода — тем же заголовком и теми же секциями.
 *
 * Нужен для опытов с передачей управления: точка входа — начало кода, поэтому опыт знает адрес
 * каждой инструкции. Обычный путь (`buildMinimalElf`) — частный случай с тремя инструкциями.
 */
export function buildElfFromCode(
  code: Uint8Array,
  base = MINIMAL_BASE,
  options: { readonly writable?: boolean; readonly extraMemory?: number } = {},
): Omit<MinimalElf, 'program'> {
  const textOffset = 0x1000;
  const sections: { name: string; offset: number; size: number }[] = [];

  // .text
  const text = code;
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

  // Заголовок программы: PT_LOAD, весь образ одним сегментом.
  //
  // Флаги: `R|X` (5) по умолчанию, `R|W|X` (7) — когда программе нужно **писать в память**.
  //
  // `extraMemory` дописывает `p_memsz` сверх `p_filesz`: хвост сегмента отображается нулями и
  // **не является страницей кода**. Это не удобство, а требование замера: QEMU делает страницу
  // переведённого кода защищённой, и запись в неё (`st` по адресу, где лежит код) кончается
  // `QEMU internal SIGSEGV {code=ACCERR}` — измерено (`src/e2k/e2kMemoryQemu.test.ts`, `.tmp/mem-page.ts`):
  // данные в той же странице, что код, → ACCERR; те же данные на отдельной странице → код возврата
  // равен записанному значению.
  const segmentSize = shstrOffset + shstr.length - textOffset;
  const extra = options.extraMemory ?? 0;
  if (!Number.isInteger(extra) || extra < 0) {
    throw new Error(`дополнительная память сегмента обязана быть неотрицательным целым, получено ${String(extra)}`);
  }
  file.writeUInt32LE(1, 0x40);
  file.writeUInt32LE(options.writable === true ? 7 : 5, 0x44);
  file.writeBigUInt64LE(BigInt(textOffset), 0x48);
  file.writeBigUInt64LE(BigInt(base), 0x50);
  file.writeBigUInt64LE(BigInt(base), 0x58);
  file.writeBigUInt64LE(BigInt(segmentSize), 0x60);
  file.writeBigUInt64LE(BigInt(segmentSize + extra), 0x68);
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

  return { bytes: new Uint8Array(file), entry: base, sections };
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
