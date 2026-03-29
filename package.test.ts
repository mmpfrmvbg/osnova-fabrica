import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

describe('package.json', () => {
  const packageJson = JSON.parse(
    readFileSync(join(__dirname, 'package.json'), 'utf-8')
  );

  it('должен иметь совместимые версии vitest и @vitest/coverage-v8', () => {
    const vitestVersion = packageJson.devDependencies.vitest;
    const coverageVersion = packageJson.devDependencies['@vitest/coverage-v8'];

    expect(vitestVersion).toBeDefined();
    expect(coverageVersion).toBeDefined();

    // Обе версии должны быть 4.x
    expect(vitestVersion).toMatch(/\^4\./);
    expect(coverageVersion).toMatch(/\^4\./);
  });

  it('должен иметь корректную структуру', () => {
    expect(packageJson.name).toBe('osnova-fabrica');
    expect(packageJson.version).toMatch(/^\d+\.\d+\.\d+/);
  });

  it('npm run ci должен повторять порядок шагов .github/workflow-scripts/ci-main.sh', () => {
    const ci = packageJson.scripts.ci as string;
    const fragments = [
      'npm --prefix apps/osiris ci',
      'npm run typecheck',
      'npm test',
      'npm run lint',
      'check-yaml-drift',
      'npm run golden',
      'npm run validate:spec',
      'npm run coverage',
    ];
    let pos = -1;
    for (const fragment of fragments) {
      const i = ci.indexOf(fragment);
      expect(i).toBeGreaterThan(pos);
      pos = i;
    }
  });
});
