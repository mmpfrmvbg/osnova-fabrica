import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
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

