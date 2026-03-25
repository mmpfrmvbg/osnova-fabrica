import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    retry: 2,
    // Root vitest should only validate the core compiler/runtime in /src.
    // Osiris has its own job + its own dependency install in CI.
    exclude: ['**/node_modules/**', '**/*.e2e.test.ts', '**/apps/osiris/**'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov', 'html'],
      include: ['src/**/*.ts'],
      exclude: ['src/**/*.test.ts', 'src/scripts/**', 'src/runtime/goldenApps.ts'],
      thresholds: {
        lines: 60,
        functions: 60,
        branches: 50,
      },
    },
  },
});
