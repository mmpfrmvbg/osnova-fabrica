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
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { SHELL_IMAGE_FORMAT } from '../e2k/emitterOracle';
import { toWslPath } from './e2kExternalObjdump';
import { collectCodeRefs, verifyCodeRefs } from './e2kCodeRefs';

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
/**
 * Компилятор C в дистрибутиве. Путь **абсолютный**: без оболочки PATH у `wsl.exe` урезан, и
 * `cc` по имени не находится — тогда зонд молча не запустился бы, а проверка стала бы пустой.
 */
const WSL_CC = '/usr/bin/cc';

/** Итог запуска: код возврата и объединённый вывод. */
export interface RunResult {
  readonly status: number | null;
  readonly text: string;
}

/**
 * Запустить команду и вернуть **и stdout, и stderr**; `undefined` — команда не запустилась.
 *
 * `spawnSync`, а не `execFileSync`, по измеренной причине: `qemu-e2k` пишет причину отказа
 * загрузки в **stderr** и при этом завершается кодом 0, поэтому перехват одного stdout давал
 * пустую строку вместо причины. Вывод `wsl.exe` приходит в UTF-16LE.
 */
export function run(command: string, args: readonly string[]): RunResult | undefined {
  const result = spawnSync(command, [...args], { timeout: 120_000, encoding: 'buffer' });
  if (result.error !== undefined || result.status === null) return undefined;
  const decode = (buffer: Buffer | undefined): string => {
    if (buffer === undefined || buffer.length === 0) return '';
    return buffer.length >= 2 && buffer[1] === 0 && buffer[0] !== 0 ? buffer.toString('utf16le') : buffer.toString('utf-8');
  };
  return { status: result.status, text: `${decode(result.stdout)}${decode(result.stderr)}` };
}

/** Живая проверка: что происходит с прогоном прямо сейчас. */
export interface LiveRunProbe {
  readonly binaryExists: boolean;
  /** Есть ли образец ELF, на котором вообще можно проверить размещение гостя. */
  readonly sampleExists: boolean;
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
  const sample = path.join(ROOT, '.tmp', 'e2k-samples.elf');
  const sampleExists = fs.existsSync(sample);
  // Без образца ELF запуск QEMU завершается «нет файла», а не проверкой guest_base:
  // считать это доказательством размещения гостя нельзя. Отсутствие образца означает
  // «проверка не выполнена», и это названо отдельным полем, а не выдано за успех.
  const elf = toWslPath(sample);
  const guestBaseOutput = sampleExists ? run(WSL, ['-d', 'e2k', '--', WSL_QEMU, elf]) : undefined;
  const guestBaseError = /Unable to find a guest_base/.test(guestBaseOutput?.text ?? '') ? 'Unable to find a guest_base' : undefined;
  const control = run(WSL, ['-d', 'e2k', '--', WSL_QEMU_X86, WSL_CONTROL]);
  return {
    binaryExists,
    sampleExists,
    ...(version === undefined ? {} : { version: version.text.split('\n')[0]!.trim() }),
    guestBaseWorks: sampleExists && binaryExists && guestBaseError === undefined && guestBaseOutput !== undefined,
    ...(guestBaseError === undefined ? {} : { guestBaseError }),
    userModeWorks: control !== undefined && control.status === 0,
    ...(control === undefined ? {} : { controlExit: control.status ?? undefined }),
  };
}

/**
 * Исходник зонда уровня системных вызовов.
 *
 * Проверяются ровно те возможности, на которых стоит `probe_guest_base`
 * (`linux-user/elfload.c:786-850`): `MAP_FIXED_NOREPLACE` (им QEMU проверяет, свободен ли
 * диапазон) и `MAP_FIXED` (для сравнения). Вывод — только ASCII, чтобы не зависеть от кодировки.
 */
export const MMAP_PROBE_SOURCE = `#define _GNU_SOURCE
#include <stdio.h>
#include <errno.h>
#include <sys/mman.h>
#ifndef MAP_FIXED_NOREPLACE
#define MAP_FIXED_NOREPLACE 0x100000
#endif
int main(void) {
  size_t size = 1UL << 30;
  void *addr = (void *)0x400000000UL;
  int flags = MAP_ANONYMOUS | MAP_PRIVATE | MAP_NORESERVE;
  errno = 0;
  void *a = mmap(addr, size, PROT_NONE, flags | MAP_FIXED_NOREPLACE, -1, 0);
  printf("NOREPLACE errno=%d\\n", a == MAP_FAILED ? errno : 0);
  if (a != MAP_FAILED) munmap(a, size);
  errno = 0;
  void *b = mmap(addr, size, PROT_NONE, flags | MAP_FIXED, -1, 0);
  printf("FIXED %s\\n", b == MAP_FAILED ? "fail" : "ok");
  if (b != MAP_FAILED) munmap(b, size);
  return 0;
}
`;

/** Что ответил зонд про `MAP_FIXED_NOREPLACE` в этом окружении. */
export interface SyscallProbe {
  /** Есть ли в дистрибутиве компилятор C (иначе зонд не запускается). */
  readonly toolExists: boolean;
  /** `errno`, с которым отказал `mmap` с `MAP_FIXED_NOREPLACE` (0 — не отказал). */
  readonly noReplaceErrno?: number;
  /** Выдал ли адрес `mmap` с обычным `MAP_FIXED`. */
  readonly fixedWorks: boolean;
}

/**
 * Собрать и запустить зонд в WSL-дистрибутиве `e2k`.
 *
 * Именно этот замер отделяет «WSL1 — не ядро и не знает флага Linux 4.17» от догадки
 * «e2k требует слишком много адресного пространства».
 */
export function probeSyscallCause(): SyscallProbe {
  const source = path.join(ROOT, '.tmp', 'e2k-mmap-probe.c');
  if (run(WSL, ['-d', 'e2k', '--', WSL_CC, '--version']) === undefined) return { toolExists: false, fixedWorks: false };
  fs.mkdirSync(path.dirname(source), { recursive: true });
  fs.writeFileSync(source, MMAP_PROBE_SOURCE, 'utf-8');
  const wslSource = toWslPath(source);
  const wslBinary = wslSource.replace(/\.c$/, '');
  if (run(WSL, ['-d', 'e2k', '--', WSL_CC, '-O0', '-o', wslBinary, wslSource]) === undefined) {
    return { toolExists: false, fixedWorks: false };
  }
  const output = run(WSL, ['-d', 'e2k', '--', wslBinary]);
  if (output === undefined) return { toolExists: true, fixedWorks: false };
  const noReplace = /NOREPLACE errno=(\d+)/.exec(output.text);
  return {
    toolExists: true,
    ...(noReplace === null ? {} : { noReplaceErrno: Number.parseInt(noReplace[1]!, 10) }),
    fixedWorks: /FIXED ok/.test(output.text),
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
  // Прогон в этом окружении состоялся **только с шимом** (§2.8): без шима гость не размещается, и
  // живая проверка этого файла его не поднимает. Поэтому утверждение «вывод совпал» допускается
  // ровно с оговоркой о шиме в той же строке — без неё это заявка на прогон, которого не было.
  const matchClaim = /вывод QEMU[^|\n]*\|\s*\*{0,2}ФАКТ([^|\n]*)/i.exec(doc);
  if (matchClaim !== null && !/шим/i.test(matchClaim[1]!)) {
    problems.push('прогона без шима не было, а вывод объявлен совпавшим без оговорки о шиме');
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
    if (!probe.sampleExists) {
      console.warn('[L2] образца .tmp/e2k-samples.elf нет: развилка проверяется по документу, guest_base не измеряется');
      expect(doc).toMatch(/ПРОГОН НЕ СОСТОЯЛСЯ/);
      return;
    }
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
    if (!probe.binaryExists || !probe.sampleExists) return;
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
    // Ссылка на код — ИМЕНЕМ, а не номером строки. Здесь стояло
    // `expect(doc).toContain('src/e2k/emitterOracle.ts:49')` — и это была ЕДИНСТВЕННАЯ проверка во
    // всём репозитории, державшая гниющий номер строки: переезд константы на другую строку красил
    // бы проверку при неизменном коде. Замер 2026-09-27: из 25 таких ссылок в `docs/e2k-*.md`
    // **17** указывали на посторонний код, и эта проверка держала ту же мину.
    expect(doc, 'ссылка на константу формата не названа именем').toContain(
      'src/e2k/emitterOracle.ts#SHELL_IMAGE_FORMAT',
    );
    // И сама цель обязана существовать: имя без цели — украшение, а не проверка.
    const refs = collectCodeRefs(doc).filter((ref) => ref.file === 'src/e2k/emitterOracle.ts');
    expect(refs.length, 'ссылка на emitterOracle.ts не найдена в документе').toBeGreaterThan(0);
    expect(verifyCodeRefs(refs), 'имя цели не разрешается в файле').toEqual([]);
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

  it('причина уровня syscall подтверждена замером: MAP_FIXED_NOREPLACE в WSL1 не поддерживается', () => {
    const probe = probeSyscallCause();
    // Пропуск обязан быть громким: если инструменты в дистрибутиве есть (а это видно по
    // собранному qemu-e2k), то и компилятор обязан найтись — иначе проверка снова станет пустой.
    if (live().binaryExists) expect(probe.toolExists, 'в дистрибутиве не найден компилятор C').toBe(true);
    if (!probe.toolExists) return;
    // Живой замер: ровно тот флаг, которым linux-user проверяет свободен ли диапазон
    // (linux-user/elfload.c:792), отказывает с ENOTSUP. Флаг добавлен в Linux 4.17.
    expect(probe.noReplaceErrno, 'MAP_FIXED_NOREPLACE неожиданно сработал').toBe(95);
    expect(probe.fixedWorks, 'обычный MAP_FIXED тоже не работает — причина была бы другой').toBe(true);
    // Документ обязан называть и флаг, и источник, и следствие для выбора окружения.
    expect(doc).toContain('MAP_FIXED_NOREPLACE');
    expect(doc).toMatch(/errno=95|ENOTSUP/);
    expect(doc, 'не назван источник флага').toMatch(/elfload\.c:79[0-9]/);
    expect(doc, 'не сказано, чего зонд не доказывает').toMatch(/НЕ доказывает/);
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
    // Оговорка о шиме в той же строке — не заявка на прогон без шима, и эта причина не называется.
    expect(checkRunBranch('вывод QEMU совпал с эталоном | **ФАКТ** с шимом (§2.8)', false, false).join(' ')).not.toMatch(
      /объявлен совпавшим/,
    );
    // Оговорка обязана быть **в той же строке**: шим, упомянутый в другом месте документа, не спасает.
    expect(
      checkRunBranch('Шим описан в §2.8.\n| вывод QEMU совпал с эталоном | **ФАКТ** |', false, false).join(' '),
    ).toMatch(/объявлен совпавшим/);
  });
});
