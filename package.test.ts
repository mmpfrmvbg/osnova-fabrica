import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { CI_STEPS } from './src/scripts/ciChain';

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
    // Список шагов `ci` переехал в модуль `src/scripts/ciChain.ts`: цепочка `&&`
    // обрывалась на первом падении (`npm test` на этой ветке красный всегда), и
    // шаги после него — включая `validate:spec` — не запускались ни разу.
    // Проверка сторожит не форму записи, а инвариант: каждый шаг bash-скрипта CI
    // присутствует в списке и в том же порядке.
    const ci = packageJson.scripts.ci as string;
    expect(ci, 'ci запускает список шагов из модуля').toContain('src/scripts/ciChain.ts');

    const ciMain = readFileSync(
      join(__dirname, '.github', 'workflow-scripts', 'ci-main.sh'),
      'utf-8',
    );
    const shellSteps = ciMain
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.length > 0 && !line.startsWith('#') && !line.startsWith('set '))
      .map((line) => line.replace(/^OSNOVA_STORAGE_ROOT=\S+\s+/, ''));

    expect(shellSteps.length, 'шаги в ci-main.sh найдены').toBeGreaterThan(5);
    let pos = -1;
    for (const step of shellSteps) {
      const i = CI_STEPS.findIndex((s) => s === step || s.endsWith(` ${step}`));
      expect(i, `шаг ci-main.sh «${step}» есть в списке шагов ci`).toBeGreaterThan(pos);
      pos = i;
    }

    // Шаги, которые были в прежней цепочке `npm run ci`, но которых нет в
    // ci-main.sh: проверяем поимённо, иначе при переносе в модуль они могли бы
    // исчезнуть молча (в ci-main.sh их нет — сверка с ним их не поймает).
    for (const step of [
      'npm run docs:check',
      'npm run gate:reorder',
      'npm run report:deprecated-end',
    ]) {
      expect(CI_STEPS, `шаг «${step}» не потерян при переносе`).toContain(step);
    }
  });
});
