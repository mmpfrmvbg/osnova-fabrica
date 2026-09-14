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
    testTimeout: 30000,
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
      '**/*.d.ts',
    ],
  },
});
