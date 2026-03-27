import { platform } from 'node:os';

import { defineConfig } from 'vitest/config';

// Windows + default thread pool: worker threads occasionally collect *.test.ts with
// "No test suite found" (describe never registers) when Vitest is spawned from
// Python/subprocess; forks avoid tinypool/thread context issues there.
const pool = platform() === 'win32' ? 'forks' : 'threads';

export default defineConfig({
  test: {
    pool,
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
