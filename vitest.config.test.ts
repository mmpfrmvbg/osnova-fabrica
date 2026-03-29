import { describe, it, expect } from 'vitest';
import config from './vitest.config';

describe('vitest.config', () => {
  it('должен иметь корректную конфигурацию test', () => {
    expect(config.test).toBeDefined();
    expect(config.test.globals).toBe(true);
    expect(config.test.failOnZeroTests).toBe(true);
  });

  it('должен иметь exclude для e2e и osiris', () => {
    expect(config.test?.exclude).toContain('**/*.e2e.test.ts');
    expect(config.test?.exclude).toContain('**/apps/osiris/**');
  });

  it('должен иметь coverage конфигурацию', () => {
    const coverage = config.test?.coverage;
    expect(coverage).toBeDefined();
    expect(coverage?.provider).toBe('v8');
    expect(coverage?.include).toContain('src/**/*.ts');
  });
});
