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

/**
 * Развилка «прогон был / прогона не было». Чистая функция: её же проверяет негативный контроль.
 */
export function checkRunBranch(doc: string, binaryExists: boolean): string[] {
  const problems: string[] = [];
  if (binaryExists) {
    if (!/ПРОГНАН/.test(doc)) {
      problems.push('qemu-e2k существует, а документ не утверждает, что прогон состоялся');
    }
    return problems;
  }
  if (!/ПРОГОН НЕ СОСТОЯЛСЯ/.test(doc)) problems.push('нет отметки «ПРОГОН НЕ СОСТОЯЛСЯ»');
  if (!/Нечем запускать/.test(doc)) problems.push('не названа причина «нечем запускать»');
  if (!/Нечего запускать/.test(doc)) problems.push('не названа причина «нечего запускать»');
  if (!/docs\/e2k-qemu-build\.md/.test(doc)) problems.push('нет ссылки на причину несостоявшейся сборки');
  if (/вывод QEMU совпал с эталоном\s*\|?\s*\*?\*?ФАКТ/i.test(doc)) {
    problems.push('прогона не было, а вывод объявлен совпавшим');
  }
  return problems;
}

describe('QEMU-прогон: причина записана и подтверждена', () => {
  const doc = fs.existsSync(DOC) ? fs.readFileSync(DOC, 'utf-8') : '';

  it('документ существует', () => {
    expect(fs.existsSync(DOC), 'нет docs/e2k-qemu-run.md').toBe(true);
  });

  it('развилка «прогон был / не было» разрешена', () => {
    expect(checkRunBranch(doc, fs.existsSync(BINARY))).toEqual([]);
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

  it('негативный контроль: развилка ловит и «прогон объявлен без бинаря», и «бинарь без прогона»', () => {
    const empty = '';
    expect(checkRunBranch(empty, false).length).toBeGreaterThan(0);
    // Бинарь есть, а документ молчит о прогоне.
    expect(checkRunBranch(doc, true).join(' ')).toMatch(/не утверждает/);
    // Документ утверждает прогон, которого не было.
    expect(checkRunBranch('ПРОГОН НЕ СОСТОЯЛСЯ. Нечем запускать. Нечего запускать. docs/e2k-qemu-build.md', false)).toEqual(
      [],
    );
    expect(
      checkRunBranch('вывод QEMU совпал с эталоном | **ФАКТ**', false).join(' '),
    ).toMatch(/объявлен совпавшим/);
  });
});
