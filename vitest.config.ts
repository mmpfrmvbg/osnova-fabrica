import { defineConfig } from 'vitest/config';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

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
    // Таймаут 30 с был тесен: замер 2026-09-19 при полном прогоне (singleFork, файлы по
    // очереди, часть оракулов ходит в WSL за `as`/`objdump`) дал `src/e2k/twoPassLayout.test.ts`
    // 31 с и `src/vliw/scheduler.test.ts` 47 с — файлы падали **по времени**, а не по проверке,
    // то есть занятость машины снова примешивалась к выводу о коде (случай 12 реестра
    // проверяемости). Таймаут поднят: он не скрывает дефекты, он отделяет их от нехватки времени.
    testTimeout: 120000,
    sequence: {
      shuffle: false,
    },
    singleFork: true,
    // Изоляция модулей обязательна: без неё состояние модульных синглтонов
    // (`_provider` в src/llm, `cachedFewShot` в OsnovaCodegen, `mockEventsQueue`
    // в vm-runner) перетекает между файлами, и один и тот же код даёт разное
    // число падений при разном порядке файлов (замер: 0 против 16 на seed 42).
    // Тест-набор перестаёт быть оракулом, если результат зависит от порядка.
    isolate: true,
    exclude: [
      '**/node_modules/**',
      '**/*.e2e.test.ts',
      '**/apps/osiris/**',
      '**/dist/**',
      // Legacy-копия прежней фабрики: не отслеживается git, её тест импортирует
      // несуществующий `proekt/utils/helpers.js`. Исключена явно, а не починена —
      // см. BIG-PICTURE.md («Fabrika2.0 — пора вывести»).
      '**/Fabrika2.0/**',
      '**/vitest.config.ts',
      '**/vitest.config.test.ts',
      '**/vitest.e2e.config.ts',
      '**/vitest.qemu.config.ts',
      '**/*.d.ts',
      // Оракулы, которым нужен ЖИВОЙ QEMU-e2k: они зависят не только от кода, но и от
      // внешнего ресурса (`qemu-e2k` в WSL) и от занятости машины. Замер 2026-09-19:
      // `e2kQemuExec.test.ts` в полном прогоне занял 62 с и упал, а отдельно прошёл
      // 5 из 5 за 12 с — то есть гейт врал о состоянии проекта. Вынесены в отдельный
      // шлюз `npm run gate:qemu` (docs/verification-debt.md, случай 12).
      '**/e2kQemuExec.test.ts',
      '**/e2kQemuRun.audit.test.ts',
      // Исполняет QEMU так же, как два предыдущих: ресурсозависимый (случай 12).
      '**/e2kSyscallRuntime.test.ts',
      // Пакеты широких команд: прогон в QEMU — внешний ресурс, тот же случай 12.
      '**/e2kWideQemu.test.ts',
      // Память (ld/st) в QEMU — тот же внешний ресурс.
      '**/e2kMemoryQemu.test.ts',
      // Массивы (память вместо invoke) в QEMU — тот же внешний ресурс.
      '**/e2kArraysQemu.test.ts',
    ],
  },
});
