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
    isolate: false,
    exclude: [
      '**/node_modules/**',
      '**/*.e2e.test.ts',
      '**/apps/osiris/**',
      '**/dist/**',
      '**/vitest.config.ts',
      '**/vitest.config.test.ts',
      '**/vitest.e2e.config.ts',
      '**/*.d.ts',
    ],
  },
});
