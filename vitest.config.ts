import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    pool: 'vmThreads',
    retry: 0,
    globals: true,
    failOnZeroTests: true,
    // Root vitest should only validate the core compiler/runtime in /src.
    // Osiris has its own job + its own dependency install in CI.
    exclude: ['**/node_modules/**', '**/*.e2e.test.ts', '**/apps/osiris/**'],
    // coverage.thresholds apply only when running with --coverage (can fail CI while plain vitest run passes).
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
        lines: 45,
        functions: 40,
        branches: 35,
      },
    },
  },
});
