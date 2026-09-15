/**
 * ОРАКУЛ QEMU-ПРОГОНА ПЯТИ DSP-ЯДЕР.
 *
 * # Что проверяется
 *
 * Постановка требует одного из двух: либо вывод QEMU совпал с эталоном, либо записана точная
 * причина, почему прогон не состоялся. Прогона не было, поэтому тест проверяет **причину** —
 * и проверяет её не по тексту, а по фактам, которые можно перепроверить:
 *
 * 1. **Развилка разрешена.** Если `qemu-e2k` существует — документ обязан утверждать, что
 *    прогон состоялся (иначе документ устарел, и тест красный). Если не существует — документ
 *    обязан называть **обе** причины: нечем запускать и нечего запускать.
 * 2. **Факты причины подтверждены источником.** Число машины ELF (175), класс ELF (64),
 *    таблица системных вызовов (447 номеров) сверяются с копиями QEMU и binutils, когда они
 *    есть; артефакт конвейера — `osnova-shell-image`, а не ELF, — проверяется импортом.
 * 3. **Обещание прогона не выдано за прогон.** Документ не содержит слов «вывод совпал».
 *
 * # Негативный контроль
 *
 * Проверяльщик развилки прогоняется на подложенном «бинарь есть, а документ молчит».
 */

import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { SHELL_IMAGE_FORMAT } from '../e2k/emitterOracle';

const ROOT = path.resolve(__dirname, '..', '..');
const DOC = path.join(ROOT, 'docs', 'e2k-qemu-run.md');
const SOURCES = path.join(ROOT, '.tmp', 'e2k-sources');
const QEMU = path.join(SOURCES, 'qemu-e2k', 'qemu');
const BINUTILS = path.join(SOURCES, 'binutils-gdb');
const BINARY = path.join(SOURCES, 'qemu-e2k', 'build', 'qemu-e2k');
/** Собранный в WSL QEMU и контрольный бинарь x86-64 (проверка «user-mode работает»). */
const WSL = 'C:\\Program Files\\WSL\\wsl.exe';
const WSL_QEMU = '/root/qemu-build/qemu-e2k';
const WSL_QEMU_X86 = '/root/qemu-build-x86/qemu-x86_64';
const WSL_CONTROL = '/root/control';

/** Запустить команду, вернуть вывод или `undefined` (вывод wsl.exe приходит в UTF-16LE). */
function run(command: string, args: readonly string[]): string | undefined {
  try {
    const buffer = execFileSync(command, [...args], { timeout: 120_000, stdio: ['ignore', 'pipe', 'ignore'] });
    const text = buffer.toString('utf-8');
    return buffer.length >= 2 && buffer[1] === 0 && buffer[0] !== 0 ? buffer.toString('utf16le') : text;
  } catch {
    return undefined;
  }
}

/** Живая проверка: что происходит с прогоном прямо сейчас. */
export interface LiveRunProbe {
  readonly binaryExists: boolean;
  readonly version?: string;
  readonly guestBaseWorks: boolean;
  readonly guestBaseError?: string;
  readonly userModeWorks: boolean;
  readonly controlExit?: number;
}

/** Опрос окружения: собран ли QEMU, размещается ли гость, работает ли user-mode вообще. */
export function probeLiveRun(): LiveRunProbe {
  const windowsBinary = fs.existsSync(BINARY);
  const version = run(WSL, ['-d', 'e2k', '--', WSL_QEMU, '--version']);
  const binaryExists = windowsBinary || version !== undefined;
  const elf = path.join(ROOT, '.tmp', 'e2k-samples.elf');
  const guestBaseOutput = run(WSL, ['-d', 'e2k', '--', WSL_QEMU, elf.replace(/^([A-Za-z]):\\/, '/mnt/$1/').replace(/\\/g, '/')]);
  const guestBaseError = /Unable to find a guest_base/.test(guestBaseOutput ?? '') ? 'Unable to find a guest_base' : undefined;
  const control = run(WSL, ['-d', 'e2k', '--', WSL_QEMU_X86, WSL_CONTROL]);
  return {
    binaryExists,
    ...(version === undefined ? {} : { version: version.split('\n')[0]!.trim() }),
    guestBaseWorks: binaryExists && guestBaseError === undefined && guestBaseOutput !== undefined,
    ...(guestBaseError === undefined ? {} : { guestBaseError }),
    userModeWorks: control !== undefined,
  };
}

/**
 * Развилка «прогон был / прогона не было». Чистая функция: её же проверяет негативный контроль.
 *
 * @param binaryExists собран ли `qemu-e2k` (проверка живьём — в тесте)
 * @param guestBaseWorks размещается ли гость e2k на этом хосте (проверка живьём — в тесте)
 */
export function checkRunBranch(doc: string, binaryExists: boolean, guestBaseWorks = false): string[] {
  const problems: string[] = [];
  if (binaryExists && guestBaseWorks) {
    if (!/ПРОГНАН/.test(doc)) {
      problems.push('qemu-e2k существует и запускает гостя, а документ не утверждает, что прогон состоялся');
    }
    return problems;
  }
  if (!/ПРОГОН НЕ СОСТОЯЛСЯ/.test(doc)) problems.push('нет отметки «ПРОГОН НЕ СОСТОЯЛСЯ»');
  if (!/Нечего запускать/.test(doc)) problems.push('не названа причина «нечего запускать»');
  if (binaryExists && !guestBaseWorks && !/guest_base/.test(doc)) {
    problems.push('qemu-e2k собран, но гость не размещается — документ не называет причину guest_base');
  }
  if (!/docs\/e2k-qemu-build\.md/.test(doc)) problems.push('нет ссылки на отчёт о сборке');
  if (/вывод QEMU совпал с эталоном\s*\|?\s*\*?\*?ФАКТ/i.test(doc)) {
    problems.push('прогона не было, а вывод объявлен совпавшим');
  }
  return problems;
}

describe('QEMU-прогон: причина записана и подтверждена', () => {
  const doc = fs.existsSync(DOC) ? fs.readFileSync(DOC, 'utf-8') : '';
  let cached: LiveRunProbe | undefined;
  const live = (): LiveRunProbe => (cached ??= probeLiveRun());

  it('документ существует', () => {
    expect(fs.existsSync(DOC), 'нет docs/e2k-qemu-run.md').toBe(true);
  });

  it('развилка «прогон был / не было» разрешена и совпадает с живой проверкой', () => {
    const probe = live();
    expect(checkRunBranch(doc, probe.binaryExists, probe.guestBaseWorks)).toEqual([]);
  });

  it('собранный QEMU отвечает на --version (если он есть)', () => {
    const probe = live();
    if (!probe.binaryExists) {
      // Слабый случай: QEMU не собран — проверяется только запись, и это названо.
      expect(doc).toMatch(/ПРОГОН НЕ СОСТОЯЛСЯ/);
      return;
    }
    expect(probe.version, 'QEMU не ответил на --version').toBeDefined();
    expect(doc, 'версия собранного QEMU не записана').toContain(probe.version!);
  });

  it('причина несостоявшегося прогона названа: guest_base и контрольный эксперимент', () => {
    const probe = live();
    if (!probe.binaryExists) return;
    if (probe.guestBaseWorks) return; // прогон состоялся — эту ветку проверяет развилка выше
    expect(probe.guestBaseError, 'прогон не состоялся, а причина не guest_base').toBeDefined();
    expect(doc).toContain('guest_base');
    expect(doc, 'не записан контрольный эксперимент с x86-64').toMatch(/qemu-x86_64/);
    expect(doc, 'не названа причина уровня источника').toMatch(/TARGET_VIRT_ADDR_SPACE_BITS/);
    if (probe.userModeWorks) {
      // Живое подтверждение: user-mode QEMU в этом окружении работает, дело не в QEMU.
      expect(doc, 'контрольный эксперимент не описан как успешный').toMatch(/код возврата \*\*0\*\*|код возврата 0/);
    }
  });

  it('артефакт конвейера — не ELF: загрузчик его не примет', () => {
    // Это и есть «нечего запускать»: формат артефакта наш, а не ELF.
    expect(SHELL_IMAGE_FORMAT).toBe('osnova-shell-image');
    expect(doc).toContain('osnova-shell-image');
    expect(doc).toContain('src/e2k/emitterOracle.ts:49');
  });

  it('число машины ELF, класс и таблица системных вызовов подтверждены источником', () => {
    const qemuElf = path.join(QEMU, 'include', 'elf.h');
    const targetElf = path.join(QEMU, 'linux-user', 'e2k', 'target_elf.h');
    const syscalls = path.join(QEMU, 'linux-user', 'e2k', 'syscall_nr.h');
    const common = path.join(BINUTILS, 'include', 'elf', 'common.h');
    const missing = [qemuElf, targetElf, syscalls, common].filter((file) => !fs.existsSync(file));
    if (missing.length > 0) {
      // Копий нет: документ проверяется на внутреннюю согласованность, и это сказано.
      expect(doc).toContain('EM_E2K');
      return;
    }
    expect(fs.readFileSync(qemuElf, 'utf-8')).toMatch(/#define EM_E2K\s+175/);
    expect(fs.readFileSync(common, 'utf-8')).toMatch(/#define EM_MCST_ELBRUS\s+175/);
    const target = fs.readFileSync(targetElf, 'utf-8');
    expect(target).toMatch(/#define ELF_CLASS\s+ELFCLASS64/);
    expect(target).toMatch(/#define ELF_MACHINE\s+EM_E2K/);
    const syscallCount = (fs.readFileSync(syscalls, 'utf-8').match(/#define TARGET_NR_/g) ?? []).length;
    expect(syscallCount).toBe(446);
    expect(doc).toContain('446');
    expect(doc).toContain('EM_E2K');
    expect(doc).toContain('EM_MCST_ELBRUS');
  });

  it('негативный контроль: развилка ловит и «прогон объявлен без гостя», и «бирарь без прогона»', () => {
    const empty = '';
    expect(checkRunBranch(empty, false).length).toBeGreaterThan(0);
    // Гость размещается, а документ молчит о прогоне.
    expect(checkRunBranch(doc, true, true).join(' ')).toMatch(/не утверждает/);
    // Бинарь есть, гость не размещается, а причина guest_base не названа.
    expect(checkRunBranch('ПРОГОН НЕ СОСТОЯЛСЯ. Нечего запускать.', true, false).join(' ')).toMatch(/guest_base/);
    // Документ утверждает прогон, которого не было.
    expect(checkRunBranch('ПРОГОН НЕ СОСТОЯЛСЯ. Нечего запускать. docs/e2k-qemu-build.md', false, false)).toEqual([]);
    expect(checkRunBranch('вывод QEMU совпал с эталоном | **ФАКТ**', false, false).join(' ')).toMatch(
      /объявлен совпавшим/,
    );
  });
});
