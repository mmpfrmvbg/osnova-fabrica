/**
 * ПРОГОН e2k-КОДА В QEMU на хосте WSL1 — через шим для `mmap`.
 *
 * # Зачем шим
 *
 * `qemu-e2k` не размещает гостя на WSL1: `probe_guest_base` (`linux-user/elfload.c:786-850`)
 * проверяет свободу диапазона через `mmap` с флагом `MAP_FIXED_NOREPLACE` (Linux 4.17+), а WSL1 —
 * слой трансляции системных вызовов, а не ядро, и отвечает на этот флаг `errno=95` (ENOTSUP).
 * Из-за этого поиск не может удаться **ни при каком** адресе: перебор `-R` и `-B` бессилен, потому
 * что оба пути кончаются тем же `mmap`.
 *
 * Шим возвращает флагу смысл, который QEMU и так ожидает: адрес запрашивается **подсказкой** (без
 * `MAP_FIXED`), а затем сверяется с запрошенным — не совпал, страница освобождается и возвращается
 * `MAP_FAILED` с `errno = EEXIST`, как поступило бы ядро. Ничего не затирается.
 *
 * **Чем шим НЕ является:** он не меняет ни трансляцию e2k, ни семантику инструкций — только способ
 * узнать у хоста, свободен ли диапазон. Отличие от настоящего флага одно: проверка перестаёт быть
 * атомарной (между сверкой и использованием адреса другой поток мог бы занять место). На этапе
 * загрузки linux-user однопоточный, а диапазон резерва остаётся замапленным.
 *
 * # Что это даёт
 *
 * С шимом QEMU **исполняет** наши байты, а не только разбирает их дизассемблером: видно, какие
 * инструкции прошли и на какой инструкции эмулятор остановился. Это самая сильная проверка
 * кодировки из доступных здесь — её не заменяет ни round-trip, ни MCST-objdump.
 */

import { execFileSync, spawnSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

const ROOT = path.resolve(__dirname, '..', '..');

/** Дистрибутив WSL и собранный в нём QEMU (см. `docs/e2k-qemu-build.md` §2.5). */
const WSL = 'C:\\Program Files\\WSL\\wsl.exe';
const WSL_DISTRO = 'e2k';
const WSL_QEMU = '/root/qemu-build/qemu-e2k';
const WSL_CC = '/usr/bin/cc';

/** Исходник шима — тот же текст, что приведён в `docs/e2k-qemu-run.md`. */
export const NOREPLACE_SHIM_SOURCE = `#define _GNU_SOURCE
#include <dlfcn.h>
#include <errno.h>
#include <stddef.h>
#include <sys/mman.h>
#include <sys/types.h>

#ifndef MAP_FIXED_NOREPLACE
#define MAP_FIXED_NOREPLACE 0x100000
#endif

static void *(*real_mmap)(void *, size_t, int, int, int, off_t);

void *mmap(void *addr, size_t length, int prot, int flags, int fd, off_t offset)
{
    if (real_mmap == NULL) {
        real_mmap = (void *(*)(void *, size_t, int, int, int, off_t))dlsym(RTLD_NEXT, "mmap");
        if (real_mmap == NULL) {
            errno = ENOSYS;
            return MAP_FAILED;
        }
    }
    if ((flags & MAP_FIXED_NOREPLACE) == 0)
        return real_mmap(addr, length, prot, flags, fd, offset);

    void *p = real_mmap(addr, length, prot, flags & ~MAP_FIXED_NOREPLACE, fd, offset);
    if (p == MAP_FAILED)
        return p;
    if (p != addr) {
        munmap(p, length);
        errno = EEXIST;
        return MAP_FAILED;
    }
    return p;
}
`;

/** Путь шима на стороне Windows; он же виден в WSL через `/mnt/...`. */
export const SHIM_SOURCE_FILE = path.join(ROOT, '.tmp', 'e2k-noreplace.c');
export const SHIM_FILE = path.join(ROOT, '.tmp', 'e2k-noreplace.so');

/** Путь Windows → путь внутри WSL. */
export function toWslPath(file: string): string {
  const absolute = path.resolve(file);
  const match = /^([A-Za-z]):[\\/](.*)$/.exec(absolute);
  return match === null ? absolute.replace(/\\/g, '/') : `/mnt/${match[1]!.toLowerCase()}/${match[2]!.replace(/\\/g, '/')}`;
}

/** Итог запуска в QEMU. */
export interface QemuRun {
  /** Объединённый вывод QEMU (причина отказа пишется в stderr, код возврата при этом 0). */
  readonly output: string;
  /** Код возврата процесса QEMU. */
  readonly status: number | null;
  /** Адрес инструкции, на которой эмулятор остановился с исключением. */
  readonly exceptionIp?: number;
  /** Код возврата гостя, если эмулятор довёл программу до выхода (`exit`). */
  readonly guestExitCode?: number;
}

/** Собрать шим в WSL. `undefined` — компилятора нет. */
export function buildShim(): string | undefined {
  if (!fs.existsSync(path.dirname(SHIM_SOURCE_FILE))) fs.mkdirSync(path.dirname(SHIM_SOURCE_FILE), { recursive: true });
  fs.writeFileSync(SHIM_SOURCE_FILE, NOREPLACE_SHIM_SOURCE, 'utf-8');
  try {
    execFileSync(WSL, ['-d', WSL_DISTRO, '--', WSL_CC, '-shared', '-fPIC', '-O2', '-o', toWslPath(SHIM_FILE), toWslPath(SHIM_SOURCE_FILE)], {
      timeout: 120_000,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch {
    return undefined;
  }
  return fs.existsSync(SHIM_FILE) ? SHIM_FILE : undefined;
}

/** Разобрать вывод QEMU: адрес исключения и код возврата гостя, если он есть. */
export function parseQemuRun(output: string, status: number | null): QemuRun {
  const ip = /exception at IP = (0x[0-9a-f]+)/.exec(output);
  return {
    output,
    status,
    ...(ip === null ? {} : { exceptionIp: Number.parseInt(ip[1]!, 16) }),
  };
}

/**
 * Запустить ELF в `qemu-e2k` **с шимом**.
 *
 * Без шима этот вызов на WSL1 отвечает `Unable to find a guest_base` и до исполнения не доходит —
 * см. `docs/e2k-qemu-run.md` §2.
 */
export function runInQemu(elfFile: string): QemuRun | undefined {
  const shim = buildShim();
  if (shim === undefined) return undefined;
  const result = spawnSync(
    WSL,
    ['-d', WSL_DISTRO, '--', 'env', `LD_PRELOAD=${toWslPath(shim)}`, WSL_QEMU, toWslPath(elfFile)],
    { timeout: 120_000, encoding: 'utf-8' },
  );
  if (result.error !== undefined && result.status === null) return undefined;
  const output = `${result.stdout ?? ''}${result.stderr ?? ''}`;
  return parseQemuRun(output, result.status);
}
