import { platform } from 'node:os';

import { defineConfig } from 'vitest/config';

// Windows: Vitest from Python/subprocess sometimes collects all *.test.ts as empty suites
// ("No test suite found"). forks + singleFork + no file-parallelism avoids tinypool quirks.
const isWin = platform() === 'win32';

export default defineConfig({
  test: {
    pool: isWin ? 'forks' : 'threads',
    ...(isWin
      ? {
          // isolate: true — иначе при isolate: false один vi.mock('../llm/index') (intake-agent.test)
          // перекрывает мок в другом файле (RepairEngineer.test), complete() зависает по таймауту.
          isolate: true,
          fileParallelism: false,
          poolOptions: { forks: { singleFork: true } },
        }
      : {}),
    retry: 2,
    // Root vitest should only validate the core compiler/runtime in /src.
    // Osiris has its own job + its own dependency install in CI.
    exclude: ['**/node_modules/**', '**/*.e2e.test.ts', '**/apps/osiris/**'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov', 'html'],
      include: ['src/**/*.ts'],
      exclude: [
        'src/**/*.test.ts',
        'src/scripts/**',
        'src/runtime/goldenApps.ts',
        // CLI / integration shells — covered by e2e/manual, exclude from unit coverage.
        'src/runtime/cli.ts',
        'src/runtime/ui.ts',
        'src/runtime/vm-runner.ts',
        'src/runtime/sandbox.ts',
        'src/runtime/run.ts',
        'src/runtime/runner.ts',
        'src/vliw/cli.ts',
      ],
      thresholds: {
        lines: 60,
        functions: 60,
        branches: 50,
      },
    },
  },
});
