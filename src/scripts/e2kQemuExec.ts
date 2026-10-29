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

/**
 * Пути шима на стороне Windows (он же виден в WSL через `/mnt/...`).
 *
 * **В имени есть pid, и это не украшение.** Шим собирался в один общий файл
 * `.tmp/e2k-noreplace.so`, а `runInQemu` вызывал сборку **на каждом прогоне** — то есть при
 * параллельном прогоне файлов шлюза (`npm run gate:qemu`) один процесс перезаписывал `.so`
 * компилятором ровно тогда, когда другой держал его в `LD_PRELOAD`. Измерено 2026-09-19: шлюз с
 * параллелизмом файлов падал в `src/e2k/e2kMemoryQemu.test.ts` три раза подряд (ожидалось 42 и 43 —
 * приходило 1), тот же файл **в одиночку** проходил, а шлюз с `--no-file-parallelism` — 6 файлов /
 * 30 проверок зелёными. Это тот же класс, что случай 12 реестра проверяемости, но на уровень
 * глубже: гейт отделил ресурс от полного прогона и не отделил от **себя**.
 * Поэтому шим свой у каждого процесса и собирается **один раз на процесс** (кэш): общий файл,
 * который переписывают под работающим загрузчиком, — это общий изменяемый артефакт, а не ресурс.
 */
export const SHIM_SOURCE_FILE = path.join(ROOT, '.tmp', `e2k-noreplace-${process.pid}.c`);
export const SHIM_FILE = path.join(ROOT, '.tmp', `e2k-noreplace-${process.pid}.so`);

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
  /**
   * КАКИМ КАНАЛОМ ПРИШЁЛ ВЫВОД — раздельно: `write(1, …)` гостя виден в `stdout`, `write(2, …)` — в
   * `stderr`. Нужно там, где канал и есть предмет проверки: отказ арены обязан идти в **stderr**, и
   * «строка где-то в объединённом выводе» этого не доказывает (`docs/hardware-debt.md` §3.89).
   */
  readonly stdout: string;
  readonly stderr: string;
  /** Код возврата процесса QEMU. */
  readonly status: number | null;
  /** Адрес инструкции, на которой эмулятор остановился с исключением. */
  readonly exceptionIp?: number;
  /** Код возврата гостя, если эмулятор довёл программу до выхода (`exit`). */
  readonly guestExitCode?: number;
}

/** Собранный в этом процессе шим: путь, либо `undefined`, если компилятора нет. */
let shimCache: string | undefined;
let shimAttempted = false;

/**
 * Собрать шим в WSL. `undefined` — компилятора нет.
 *
 * Собирается **один раз на процесс** (результат кэшируется вместе с отказом): сборка на каждом
 * прогоне переписывала общий `.so` под работающим загрузчиком (см. историю путей выше).
 */
export function buildShim(): string | undefined {
  if (shimAttempted) return shimCache;
  shimAttempted = true;
  if (!fs.existsSync(path.dirname(SHIM_SOURCE_FILE))) fs.mkdirSync(path.dirname(SHIM_SOURCE_FILE), { recursive: true });
  fs.writeFileSync(SHIM_SOURCE_FILE, NOREPLACE_SHIM_SOURCE, 'utf-8');
  try {
    execFileSync(WSL, ['-d', WSL_DISTRO, '--', WSL_CC, '-shared', '-fPIC', '-O2', '-o', toWslPath(SHIM_FILE), toWslPath(SHIM_SOURCE_FILE)], {
      timeout: 120_000,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch {
    shimCache = undefined;
    return undefined;
  }
  shimCache = fs.existsSync(SHIM_FILE) ? SHIM_FILE : undefined;
  return shimCache;
}

/** Разобрать вывод QEMU: адрес исключения и код возврата гостя, если он есть. */
export function parseQemuRun(
  output: string,
  status: number | null,
  streams: { readonly stdout?: string; readonly stderr?: string } = {},
): QemuRun {
  const ip = /exception at IP = (0x[0-9a-f]+)/.exec(output);
  return {
    output,
    stdout: streams.stdout ?? '',
    stderr: streams.stderr ?? '',
    status,
    ...(ip === null ? {} : { exceptionIp: Number.parseInt(ip[1]!, 16) }),
  };
}

/**
 * Запустить ELF в `qemu-e2k`.
 *
 * @param options.shim `false` — запуск **без** шима: нужен, чтобы показать, что преграда WSL1
 *   (`guest_base`) снимается именно шимом, а не чем-то ещё.
 * @param options.timeoutMs бюджет прогона. По умолчанию 120 с — столько нужно оракулам, которые
 *   честно ждут QEMU. Для **бисекции** зависаний он мал намеренно: там важно быстро отличить
 *   «модель считает» от «модель встала», и 30 с хватает (`docs/e2k-setwd-memory.md` §2).
 */
export function runInQemu(
  elfFile: string,
  options: { shim?: boolean; timeoutMs?: number } = {},
): QemuRun | undefined {
  const withShim = options.shim !== false;
  const shim = withShim ? buildShim() : undefined;
  if (withShim && shim === undefined) return undefined;
  const env = shim === undefined ? [] : [`LD_PRELOAD=${toWslPath(shim)}`];
  const result = spawnSync(
    WSL,
    ['-d', WSL_DISTRO, '--', ...(env.length === 0 ? [] : ['env', ...env]), WSL_QEMU, toWslPath(elfFile)],
    // ГИГИЕНА РАННЕРА (A4-5з, задача 0). По умолчанию `spawnSync` по таймауту шлёт SIGTERM и на
    // этом успокаивается: модель, которая не отвечает на SIGTERM (зацикленный `std` в кадре
    // `call wbs = 16`, §3.137.5), ОСТАЁТСЯ ЖИТЬ и держит ELF открытым — следующий прогон падает
    // `UNKNOWN: unknown error, open '…elf'`. Проверено трижды (5ж/2, 5ж/4, 5з/0). SIGKILL
    // снимает процесс безусловно, а `spawnSync` дожидается его выхода, поэтому «висит» не остаётся.
    { timeout: options.timeoutMs ?? 120_000, killSignal: 'SIGKILL', encoding: 'utf-8' },
  );
  if (result.error !== undefined && result.status === null) {
    // ГИГИЕНА РАННЕРА, ЧАСТЬ ВТОРАЯ (A4-5з, задача 0): по таймауту Node убивает `wsl.exe`, а гость
    // ВНУТРИ WSL остаётся жить (измерено: осиротевший `qemu-e2k` жил 7:47 и жёг ядро, держа ELF
    // открытым, — тогда следующий прогон падает `UNKNOWN: unknown error, open '…elf'`). Поэтому
    // снимаем гостя ПРИЦЕЛЬНО по пути его ELF: общий `pkill -f qemu-e2k` убил бы и чужой живой
    // прогон (в дереве работают несколько агентов одновременно).
    spawnSync(WSL, ['-d', WSL_DISTRO, '--', 'pkill', '-f', toWslPath(elfFile)], { encoding: 'utf-8' });
    return undefined;
  }
  const output = `${result.stdout ?? ''}${result.stderr ?? ''}`;
  return parseQemuRun(output, result.status, { stdout: result.stdout ?? '', stderr: result.stderr ?? '' });
}
