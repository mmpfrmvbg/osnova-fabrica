import { defineConfig } from 'vitest/config';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * ОТДЕЛЬНЫЙ ШЛЮЗ ДЛЯ ОРАКУЛОВ, КОТОРЫМ НУЖЕН ЖИВОЙ QEMU-e2k.
 *
 * # Почему они не в полном прогоне
 *
 * Эти оракулы зависят не только от кода, но и от **внешнего ресурса** (`qemu-e2k` в WSL под
 * шимом `mmap`) и от занятости машины. Замер 2026-09-19: `src/e2k/e2kQemuExec.test.ts` в полном
 * прогоне занял **62 с** и упал, а отдельно прошёл **5 из 5 за 12 с**. Оракул, который иногда
 * падает, **врёт о состоянии проекта**: его падение перестаёт означать дефект, и вместе с ним
 * обесценивается весь полный прогон (`docs/verification-debt.md`, случай 12).
 *
 * Поэтому полный прогон (`npm test`) их **не содержит** — он детерминирован, — а этот шлюз
 * запускается отдельно: `npm run gate:qemu`.
 *
 * # Что здесь и почему именно это
 *
 * | файл | чем зависит от ресурса |
 * |---|---|
 * | `src/e2k/e2kQemuExec.test.ts` | запускает `qemu-e2k` с шимом и **исполняет** наши байты |
 * | `src/scripts/e2kQemuRun.audit.test.ts` | пробует живой прогон и сверяет с ним документ |
 *
 * # Чего шлюз НЕ делает
 *
 * Не делает результат «непроверенным»: оба оракула по-прежнему обязаны проходить — просто в своём
 * прогоне, где занятость машины не примешивается к выводу о коде. Таймаут поднят намеренно: здесь
 * измеряется внешний ресурс, а не скорость нашего кода.
 */
export default defineConfig({
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  test: {
    pool: 'forks',
    retry: 0,
    globals: true,
    failOnZeroTests: true,
    // 30 с из полного прогона здесь мало: в замере один файл занял 62 с.
    testTimeout: 180000,
    sequence: {
      shuffle: false,
    },
    singleFork: true,
    isolate: true,
    include: [
      'src/e2k/e2kQemuExec.test.ts',
      'src/scripts/e2kQemuRun.audit.test.ts',
      'src/e2k/e2kSyscallRuntime.test.ts',
      'src/e2k/e2kWideQemu.test.ts',
    ],
  },
});
