import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    retry: 0,
    include: ['apps/osiris/src/http/**/*.e2e.test.ts'],
  },
});
