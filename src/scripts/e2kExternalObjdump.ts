/**
 * ВНЕШНЯЯ ПРОВЕРКА КОДИРОВКИ e2k: НАШИ БАЙТЫ ЧЕРЕЗ MCST-ДИЗАССЕМБЛЕР.
 *
 * # Зачем
 *
 * Кодировка e2k извлечена из четырёх открытых описаний и проверена round-trip
 * (`docs/e2k-real-run.md`), но **внешнего** подтверждения не было: ни MCST-objdump, ни QEMU
 * в окружении не собраны (`docs/e2k-qemu-build.md` §2), компилятора e2k на Compiler Explorer
 * нет (`docs/e2k-external-validation.md` §1). Этот модуль закрывает пробел: он берёт образцы
 * (`src/scripts/extractE2kSamples.ts`), упаковывает их в ELF с `e_machine = 175` и отдаёт
 * **чужому** дизассемблеру — `objdump` из binutils МЦСТ, собранного в WSL.
 *
 * # Два исхода, и оба записываются
 *
 * | исход | что записывается |
 * |---|---|
 * | дизассемблер найден | по каждому образцу: `совпал` / `не совпал` + текст дизассемблера |
 * | не найден | по каждому образцу: `НЕ ПРОВЕРЕНО` + **точная причина** (что именно не найдено) |
 *
 * # Чем это отличается от round-trip
 *
 * Round-trip (`encode` → `decode`) проверяет **согласованность нашей реализации с самой собой**.
 * Здесь байты читает **чужой** код, написанный МЦСТ, и печатает инструкцию по своей таблице
 * опкодов. Совпадение мнемоники, канала и операндов — внешнее подтверждение; расхождение —
 * находка, которую нельзя списать на самосогласованность.
 *
 * # Чего проверка НЕ доказывает
 *
 * Что байты исполнит железо: дизассемблер и исполнение — разные вещи. И что проверены все
 * формы: образцов десять, а реализовано 23 операции.
 *
 * Использование:
 *   npx tsx src/scripts/e2kExternalObjdump.ts            # проверить и записать .tmp/e2k-external-objdump.json
 *   E2K_OBJDUMP=/путь/к/objdump npx tsx src/scripts/e2kExternalObjdump.ts   # свой инструмент
 */

import * as fs from 'fs';
import * as path from 'path';
import { execFileSync } from 'child_process';
import { buildSamples, type E2kSample } from './extractE2kSamples';

const ROOT = path.resolve(__dirname, '..', '..');
const ELF_FILE = path.join(ROOT, '.tmp', 'e2k-samples.elf');
const REPORT_FILE = path.join(ROOT, '.tmp', 'e2k-external-objdump.json');
const WSL_DISTRO = 'e2k';
const WSL_OBJDUMP = '/root/build/binutils/objdump';

/** Формат отчёта — НАШЕ РЕШЕНИЕ. */
export const EXTERNAL_REPORT_FORMAT = 'osnova-e2k-external-objdump';

/** Базовый адрес секции `.text` в собранном ELF. */
export const ELF_BASE = 0x100000;

/** `e_machine = 175` — `EM_E2K` (`qemu/include/elf.h:195`) = `EM_MCST_ELBRUS` (`binutils-gdb/include/elf/common.h:295`). */
const EM_E2K = 175;

/**
 * Номер машины в `e_flags`: биты 24..31 (`binutils-gdb/include/elf/e2k.h:113-115`),
 * значение `E_E2K_MACH_EV5 = 5` — это **уровень ISA** (номера `bfd_mach_e2k_ev5` и
 * `E_E2K_MACH_EV5` совпадают по значению: `bfd/bfd-in2.h:1783-1784`).
 *
 * **БЫЛО 19** (`bfd_mach_e2k_8c`). 19 — код **`-mtune=elbrus-8c`** (`e2k.h:135`), то есть
 * кристалла, а не уровня ISA; такой ELF ядро e2k **отвергает** (`ENOEXEC`, код возврата 126)
 * и принимает с 5 — измерено на живой машине, разбор `docs/hardware-debt.md` §3.108.
 *
 * На разбор здешнего ELF смена НЕ влияет, и это замерено там же: `objdump -d` на одном и том же
 * образе с 19 и с 5 даёт посимвольно один и тот же вывод (107 строк-команд, отличий нет).
 */
const MACH_V5 = 5;

/** Один образец в раскладке ELF. */
export interface ElfLayoutEntry {
  readonly key: string;
  readonly address: number;
  readonly size: number;
  readonly mnemonic: string;
  readonly channel: number;
  readonly form: string;
  readonly operands: readonly number[];
}

/** Собранный ELF: байты и раскладка. */
export interface E2kElf {
  readonly bytes: Buffer;
  readonly layout: readonly ElfLayoutEntry[];
}

/** Ключ образца: «мнемоника,канал». */
export function sampleKey(sample: { mnemonic: string; channel: number }): string {
  return `${sample.mnemonic},${sample.channel}`;
}

/**
 * Собрать ELF64 с секцией `.text` из образцов.
 *
 * Каждый образец выравнивается до 16 байт: иначе две соседние команды могут быть прочитаны
 * дизассемблером как одна широкая команда, и сравнение сломается не по нашей вине.
 */
export function buildE2kElf(samples: readonly E2kSample[]): E2kElf {
  const code = Buffer.alloc(0);
  const chunks: Buffer[] = [];
  const layout: ElfLayoutEntry[] = [];
  let offset = 0;
  for (const sample of samples) {
    const raw = Buffer.from(sample.hex.trim().split(/\s+/).map((byte) => Number.parseInt(byte, 16)));
    if (raw.length !== sample.size) throw new Error(`${sample.mnemonic}: байт ${raw.length}, заявлено ${sample.size}`);
    const entry: ElfLayoutEntry = {
      key: sampleKey(sample),
      address: ELF_BASE + offset,
      size: sample.size,
      mnemonic: sample.mnemonic,
      channel: sample.channel,
      form: sample.form,
      operands: sample.operands.map((operand) => (operand.kind === 'reg' ? operand.index : Number.NaN)),
    };
    chunks.push(raw);
    const padding = (16 - (raw.length % 16)) % 16;
    chunks.push(Buffer.alloc(padding));
    layout.push(entry);
    offset += raw.length + padding;
  }
  void code;

  const text = Buffer.concat(chunks);
  const textOffset = 0x1000;
  const shstr = Buffer.from('\u0000.text\u0000.shstrtab\u0000', 'latin1');
  const shstrOffset = textOffset + text.length;
  const shoff = align(textOffset + text.length + shstr.length + 8, 8);

  const file = Buffer.alloc(shoff + 3 * 64);
  file[0] = 0x7f;
  file.write('ELF', 1, 'latin1');
  file[4] = 2; // ELFCLASS64
  file[5] = 1; // little-endian
  file[6] = 1; // EV_CURRENT
  const ehdr = {
    type: 2, // ET_EXEC
    machine: EM_E2K,
    version: 1,
    entry: ELF_BASE,
    phoff: 0x40,
    shoff,
    flags: MACH_V5 << 24,
    ehsize: 64,
    phentsize: 56,
    phnum: 1,
    shentsize: 64,
    shnum: 3,
    shstrndx: 2,
  };
  file.writeUInt16LE(ehdr.type, 16);
  file.writeUInt16LE(ehdr.machine, 18);
  file.writeUInt32LE(ehdr.version, 20);
  file.writeBigUInt64LE(BigInt(ehdr.entry), 24);
  file.writeBigUInt64LE(BigInt(ehdr.phoff), 32);
  file.writeBigUInt64LE(BigInt(ehdr.shoff), 40);
  file.writeUInt32LE(ehdr.flags, 48);
  file.writeUInt16LE(ehdr.ehsize, 52);
  file.writeUInt16LE(ehdr.phentsize, 54);
  file.writeUInt16LE(ehdr.phnum, 56);
  file.writeUInt16LE(ehdr.shentsize, 58);
  file.writeUInt16LE(ehdr.shnum, 60);
  file.writeUInt16LE(ehdr.shstrndx, 62);
  // Заголовок программы: PT_LOAD, R+X
  file.writeUInt32LE(1, 0x40);
  file.writeUInt32LE(5, 0x44);
  file.writeBigUInt64LE(BigInt(textOffset), 0x48);
  file.writeBigUInt64LE(BigInt(ELF_BASE), 0x50);
  file.writeBigUInt64LE(BigInt(ELF_BASE), 0x58);
  file.writeBigUInt64LE(BigInt(text.length), 0x60);
  file.writeBigUInt64LE(BigInt(text.length), 0x68);
  file.writeBigUInt64LE(0x1000n, 0x70);

  text.copy(file, textOffset);
  shstr.copy(file, shstrOffset);

  const sections = [
    { name: 0, type: 0, flags: 0n, addr: 0n, off: 0n, size: 0n, link: 0, info: 0, align: 1n, entsize: 0n },
    {
      name: shstr.indexOf('.text'),
      type: 1,
      flags: 6n,
      addr: BigInt(ELF_BASE),
      off: BigInt(textOffset),
      size: BigInt(text.length),
      link: 0,
      info: 0,
      align: 1n,
      entsize: 0n,
    },
    {
      name: shstr.indexOf('.shstrtab'),
      type: 3,
      flags: 0n,
      addr: 0n,
      off: BigInt(shstrOffset),
      size: BigInt(shstr.length),
      link: 0,
      info: 0,
      align: 1n,
      entsize: 0n,
    },
  ];
  sections.forEach((section, index) => {
    const at = shoff + index * 64;
    file.writeUInt32LE(section.name, at);
    file.writeUInt32LE(section.type, at + 4);
    file.writeBigUInt64LE(section.flags, at + 8);
    file.writeBigUInt64LE(section.addr, at + 16);
    file.writeBigUInt64LE(section.off, at + 24);
    file.writeBigUInt64LE(section.size, at + 32);
    file.writeUInt32LE(section.link, at + 40);
    file.writeUInt32LE(section.info, at + 44);
    file.writeBigUInt64LE(section.align, at + 48);
    file.writeBigUInt64LE(section.entsize, at + 56);
  });

  return { bytes: file, layout };
}

function align(value: number, to: number): number {
  return Math.ceil(value / to) * to;
}

/** Найденный внешний инструмент. */
export interface ExternalTool {
  readonly kind: 'objdump';
  /** Как запускать: напрямую или через WSL. */
  readonly runner: { readonly command: string; readonly args: readonly string[] };
  readonly version: string;
  readonly origin: string;
}

/**
 * Вывод `wsl.exe` приходит в консоль в UTF-16LE, и Node, читая его как UTF-8, вставляет
 * NUL между символами. Это измеренная особенность: без её учёта разбор вывода даёт пустоту.
 */
export function decodeConsoleOutput(buffer: Buffer): string {
  const asUtf8 = buffer.toString('utf-8');
  if (buffer.length >= 2 && buffer[1] === 0 && buffer[0] !== 0) {
    return buffer.toString('utf16le').replace(/\u0000+$/, '');
  }
  return asUtf8;
}

function tryRun(command: string, args: readonly string[]): string | undefined {
  try {
    const buffer = execFileSync(command, [...args], { timeout: 180_000, stdio: ['ignore', 'pipe', 'ignore'] });
    return decodeConsoleOutput(buffer);
  } catch {
    return undefined;
  }
}

/** Путь Windows → путь внутри WSL (`D:\a\b` → `/mnt/d/a/b`). */
export function toWslPath(file: string): string {
  const absolute = path.resolve(file);
  const match = /^([A-Za-z]):[\\/](.*)$/.exec(absolute);
  if (match === null) return absolute.replace(/\\/g, '/');
  return `/mnt/${match[1]!.toLowerCase()}/${match[2]!.replace(/\\/g, '/')}`;
}

/**
 * Найти внешний дизассемблер e2k.
 *
 * Порядок: переменная `E2K_OBJDUMP` → собранный в WSL `/root/build/binutils/objdump` →
 * `e2k-linux-objdump` / `e2k-elf64-objdump` в `PATH`. Имя `objdump` без префикса **не берётся**:
 * это родной дизассемблер хозяйской машины, он e2k не знает.
 */
export function findExternalTool(): { tool?: ExternalTool; reason?: string } {
  const explicit = process.env.E2K_OBJDUMP;
  if (explicit !== undefined && explicit !== '') {
    const version = tryRun(explicit, ['--version']);
    if (version === undefined) return { reason: `E2K_OBJDUMP=${explicit}: файл не запускается` };
    return { tool: { kind: 'objdump', runner: { command: explicit, args: [] }, version: version.split('\n')[0]!, origin: 'E2K_OBJDUMP' } };
  }
  // В PATH лежит устаревшая заглушка System32\wsl.exe, которая не знает про установленный
  // дистрибутив; рабочая программа — `%ProgramFiles%\WSL\wsl.exe`. Пробуем обе.
  const wslCandidates = [
    process.env.ProgramFiles === undefined ? undefined : path.join(process.env.ProgramFiles, 'WSL', 'wsl.exe'),
    'wsl.exe',
  ].filter((value): value is string => value !== undefined);
  for (const wsl of wslCandidates) {
    const wslVersion = tryRun(wsl, ['-d', WSL_DISTRO, '--', WSL_OBJDUMP, '--version']);
    if (wslVersion === undefined) continue;
    return {
      tool: {
        kind: 'objdump',
        runner: { command: wsl, args: ['-d', WSL_DISTRO, '--', WSL_OBJDUMP] },
        version: wslVersion.split('\n').map((line) => line.replace(/\u0000/g, '').trim()).filter(Boolean)[0]!,
        origin: `сборка binutils в WSL-дистрибутиве ${WSL_DISTRO} (${WSL_OBJDUMP})`,
      },
    };
  }
  for (const name of ['e2k-linux-objdump', 'e2k-elf64-objdump', 'e2k-unknown-linux-gnu-objdump']) {
    const version = tryRun(name, ['--version']);
    if (version !== undefined) {
      return { tool: { kind: 'objdump', runner: { command: name, args: [] }, version: version.split('\n')[0]!, origin: 'PATH' } };
    }
  }
  return {
    reason:
      `дизассемблер e2k не найден: нет E2K_OBJDUMP, нет /root/build/binutils/objdump в WSL-дистрибутиве ` +
      `«${WSL_DISTRO}», нет e2k-*-objdump в PATH. Родной objdump машины не годится — он не знает e2k`,
  };
}

/** Одна разобранная строка дизассемблера. */
export interface DisasmLine {
  readonly address: number;
  readonly bytes: string;
  readonly text: string;
}

/**
 * Разобрать вывод `objdump -d` дизассемблера e2k.
 *
 * Формат необычен и это **измеренный факт**: строка адреса печатается **без** байтов, а текст
 * инструкции уходит на следующую строку:
 *
 * ```
 *   100000:	
 *   adds,0 %b[1], %b[2], %b[3]
 * ```
 *
 * Поэтому строки с адресом открывают запись, а последующие непустые строки её дополняют
 * (у широкой команды слогов несколько, и текст может занимать несколько строк).
 */
export function parseObjdumpOutput(output: string): DisasmLine[] {
  const lines: DisasmLine[] = [];
  let current: { address: number; parts: string[] } | undefined;
  const flush = (): void => {
    if (current !== undefined) {
      lines.push({ address: current.address, bytes: '', text: current.parts.join(' ').trim() });
      current = undefined;
    }
  };
  for (const raw of output.split(/\r?\n/)) {
    const withAddress = /^\s*([0-9a-f]{4,})\s*:\s*(.*)$/.exec(raw);
    if (withAddress !== null) {
      flush();
      const rest = withAddress[2]!.replace(/^\s*(?:[0-9a-f]{2}\s+)+/, '').trim();
      current = { address: Number.parseInt(withAddress[1]!, 16), parts: rest === '' ? [] : [rest] };
      continue;
    }
    if (/^\s*Disassembly of section/.test(raw)) continue;
    if (/^\s*[0-9a-f]{8,}\s+<.*>:\s*$/.test(raw)) continue;
    if (raw.trim() === '') continue;
    if (current !== undefined) current.parts.push(raw.trim());
  }
  flush();
  return lines;
}

/**
 * Числа, которые дизассемблер МЦСТ печатает по **нашему** образу.
 *
 * Зачем отдельно от `parseObjdumpOutput`: тот даёт текст строки, а сверять надо **значения**.
 * Ожидание, выведенное из наших же вычислений (`0x${textAddress.toString(16)}`), уезжает вместе
 * с ошибкой в этих вычислениях и потому ничего не доказывает; значение, прочитанное из вывода
 * дизассемблера, доказывает round-trip «наши байты → чужая расшифровка».
 *
 * Имена регистров — **измеренный факт**: `reg_prefix[] = {"", "d", "q", "qp"}` (`opcodes/e2k-dis.c:407`),
 * печать `"%%%sr%d"` (`:575`), поэтому 64-битный приёмник литерала печатается `%dr10`, а не `%r10`.
 */
export interface DisasmFacts {
  /** Значение литерала из `movtd,0 _f64 0x…` — то, что действительно лежит в байтах. */
  readonly literalValue?: bigint;
  /** Приёмник литерала так, как его печатает дизассемблер (измерено: `%dr10`). */
  readonly literalRegister?: string;
  /** `rsz` из `setbn rbs = …, rsz = …`. */
  readonly rsz?: number;
  /** Иммедиаты `wbs` из `call …, wbs = …` — в порядке появления. */
  readonly wbs: readonly number[];
  /** Иммедиаты `sdisp %ctprN, …` — в порядке появления. */
  readonly sdisp: readonly number[];
}

/** Разобрать числа из строк дизассемблера. Чистая функция: у неё свой негативный контроль. */
export function disasmFacts(lines: readonly string[]): DisasmFacts {
  let literalValue: bigint | undefined;
  let literalRegister: string | undefined;
  let rsz: number | undefined;
  const wbs: number[] = [];
  const sdisp: number[] = [];
  for (const line of lines) {
    if (literalValue === undefined) {
      const literal = /movtd,\d+\s+_f64\s+0x([0-9a-f]+)\s*,\s*(%[a-z]+\d+)/.exec(line);
      if (literal !== null) {
        literalValue = BigInt(`0x${literal[1]!}`);
        literalRegister = literal[2]!;
      }
    }
    if (rsz === undefined) {
      const parsed = /\brsz\s*=\s*0x([0-9a-f]+)/.exec(line);
      if (parsed !== null) rsz = Number.parseInt(parsed[1]!, 16);
    }
    const wbsValue = /\bwbs\s*=\s*0x([0-9a-f]+)/.exec(line);
    if (wbsValue !== null) wbs.push(Number.parseInt(wbsValue[1]!, 16));
    const sdispValue = /\bsdisp\s+%ctpr\d+\s*,\s*0x([0-9a-f]+)/.exec(line);
    if (sdispValue !== null) sdisp.push(Number.parseInt(sdispValue[1]!, 16));
  }
  return { literalValue, literalRegister, rsz, wbs, sdisp };
}

/** Разобранная инструкция из текста дизассемблера. */
export interface DisasmInstruction {
  readonly mnemonic: string;
  readonly channel: number;
  readonly operands: readonly number[];
}

/**
 * Разобрать текст инструкции вида «adds,0 %b[1], %b[2], %b[3]» (или «adds,0 %r1, %r2, %r3»).
 *
 * Формат печати взят из источника: `opcodes/e2k-dis.c:1134` — `"%s,%d%s "`, затем операнды.
 *
 * Имена регистров: дизассемблер МЦСТ печатает **базовые** регистры — `%b[N]` для одиночных
 * и `%db[N]` для двойных (`opcodes/e2k-dis.c:417`, `:454`), а наши образцы записаны как `%rN`
 * (обозначение руководства). Сверяются **номера** регистров и их порядок: имя файла регистров —
 * вопрос обозначения, а не кодировки, и оно записывается отдельной находкой.
 */
export function parseInstructionText(text: string): DisasmInstruction | undefined {
  const match = /^([a-z0-9_]+),(\d+)(?:,sm)?\s*(.*)$/.exec(text.trim());
  if (match === null) return undefined;
  const operands = [...match[3]!.matchAll(/%d?b\[(\d+)\]|%r(\d+)/g)].map((one) =>
    Number.parseInt(one[1] ?? one[2]!, 10),
  );
  return { mnemonic: match[1]!, channel: Number.parseInt(match[2]!, 10), operands };
}

/** Результат сверки одного образца. */
export interface SampleComparison {
  readonly key: string;
  readonly address: number;
  readonly expected: string;
  readonly actual?: string;
  readonly status: 'совпал' | 'не совпал' | 'НЕ ПРОВЕРЕНО';
  readonly reason: string;
}

/** Сверить образцы с выводом дизассемблера. Чистая функция — её проверяет негативный контроль. */
export function compareSamples(
  layout: readonly ElfLayoutEntry[],
  lines: readonly DisasmLine[],
): SampleComparison[] {
  const byAddress = new Map(lines.map((line) => [line.address, line]));
  return layout.map((entry) => {
    const line = byAddress.get(entry.address);
    const expected = `${entry.mnemonic},${entry.channel} ${entry.operands.map((operand) => `%r${operand}`).join(', ')}`;
    if (line === undefined) {
      return {
        key: entry.key,
        address: entry.address,
        expected,
        status: 'НЕ ПРОВЕРЕНО' as const,
        reason: `дизассемблер не напечатал строку по адресу 0x${entry.address.toString(16)}`,
      };
    }
    const instruction = parseInstructionText(line.text);
    if (instruction === undefined) {
      return {
        key: entry.key,
        address: entry.address,
        expected,
        actual: line.text,
        status: 'НЕ ПРОВЕРЕНО' as const,
        reason: `строку «${line.text}» не удалось разобрать как инструкцию`,
      };
    }
    const problems: string[] = [];
    if (instruction.mnemonic !== entry.mnemonic) {
      problems.push(`мнемоника: у нас «${entry.mnemonic}», у дизассемблера «${instruction.mnemonic}»`);
    }
    if (instruction.channel !== entry.channel) {
      problems.push(`канал: у нас ${entry.channel}, у дизассемблера ${instruction.channel}`);
    }
    const actualOperands = instruction.operands.join(', ');
    const expectedOperands = entry.operands.join(', ');
    if (actualOperands !== expectedOperands) {
      problems.push(`операнды: у нас [${expectedOperands}], у дизассемблера [${actualOperands}]`);
    }
    return {
      key: entry.key,
      address: entry.address,
      expected,
      actual: line.text,
      status: problems.length === 0 ? ('совпал' as const) : ('не совпал' as const),
      reason: problems.length === 0 ? 'мнемоника, канал и операнды совпали с нашими' : problems.join('; '),
    };
  });
}

/** Отчёт о внешней проверке. */
export interface ExternalReport {
  readonly format: string;
  readonly version: number;
  readonly tool: ExternalTool | null;
  readonly unavailableReason?: string;
  readonly elf: string;
  readonly comparisons: readonly SampleComparison[];
  readonly summary: { readonly total: number; readonly matched: number; readonly mismatched: number; readonly unverified: number };
}

/** Прогнать внешнюю проверку: собрать ELF, найти инструмент, сверить. */
export function runExternalCheck(): ExternalReport {
  const samples = buildSamples();
  const elf = buildE2kElf(samples);
  fs.mkdirSync(path.dirname(ELF_FILE), { recursive: true });
  fs.writeFileSync(ELF_FILE, elf.bytes);

  const { tool, reason } = findExternalTool();
  if (tool === undefined) {
    return {
      format: EXTERNAL_REPORT_FORMAT,
      version: 1,
      tool: null,
      unavailableReason: reason!,
      elf: path.relative(ROOT, ELF_FILE),
      comparisons: elf.layout.map((entry) => ({
        key: entry.key,
        address: entry.address,
        expected: `${entry.mnemonic},${entry.channel} ${entry.operands.map((operand) => `%r${operand}`).join(', ')}`,
        status: 'НЕ ПРОВЕРЕНО' as const,
        reason: reason!,
      })),
      summary: { total: elf.layout.length, matched: 0, mismatched: 0, unverified: elf.layout.length },
    };
  }

  // Путь к ELF: для WSL — из /mnt, иначе обычный.
  const elfPath = tool.runner.command.toLowerCase().includes('wsl') ? toWslPath(ELF_FILE) : ELF_FILE;
  const output = tryRun(tool.runner.command, [...tool.runner.args, '-d', elfPath]) ?? '';
  const comparisons = compareSamples(elf.layout, parseObjdumpOutput(output));
  return {
    format: EXTERNAL_REPORT_FORMAT,
    version: 1,
    tool,
    elf: path.relative(ROOT, ELF_FILE),
    comparisons,
    summary: {
      total: comparisons.length,
      matched: comparisons.filter((item) => item.status === 'совпал').length,
      mismatched: comparisons.filter((item) => item.status === 'не совпал').length,
      unverified: comparisons.filter((item) => item.status === 'НЕ ПРОВЕРЕНО').length,
    },
  };
}

/** Разобрать произвольный ELF внешним дизассемблером: текст вывода и найденный инструмент. */
export function disassembleElf(
  elf: E2kElf,
  file = path.join(ROOT, '.tmp', 'e2k-disasm.elf'),
): { text: string; tool: ExternalTool } | undefined {
  const { tool } = findExternalTool();
  if (tool === undefined) return undefined;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, elf.bytes);
  const target = tool.runner.command.toLowerCase().includes('wsl') ? toWslPath(file) : file;
  const output = tryRun(tool.runner.command, [...tool.runner.args, '-d', target]);
  if (output === undefined) return undefined;
  return { text: output, tool };
}

function main(): void {
  const report = runExternalCheck();
  fs.writeFileSync(REPORT_FILE, `${JSON.stringify(report, null, 2)}\n`, 'utf-8');
  if (report.tool === null) {
    console.log(`инструмент не найден: ${report.unavailableReason}`);
  } else {
    console.log(`инструмент: ${report.tool.version} (${report.tool.origin})`);
  }
  for (const item of report.comparisons) {
    const mark = item.status === 'совпал' ? 'OK  ' : item.status === 'не совпал' ? 'РАСХ' : 'НЕТ ';
    console.log(`${mark} ${item.key.padEnd(12)} 0x${item.address.toString(16)}  ожидалось: ${item.expected}`);
    if (item.actual !== undefined) console.log(`     дизассемблер: ${item.actual}`);
    if (item.status !== 'совпал') console.log(`     ${item.reason}`);
  }
  console.log(
    `итого: ${report.summary.total}; совпало ${report.summary.matched}; расхождений ${report.summary.mismatched}; не проверено ${report.summary.unverified}`,
  );
  console.log(`отчёт: ${path.relative(ROOT, REPORT_FILE)}`);
}

if (require.main === module) {
  main();
}
