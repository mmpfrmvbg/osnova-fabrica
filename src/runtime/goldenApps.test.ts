import { describe, it, expect } from 'vitest';
import { runGoldenCheck } from './goldenApps';
import { compileSource } from '../compiler/compiler';
import type { OsnovaSpec } from '../pipeline/types';

const makeSpec = (overrides: Partial<OsnovaSpec> = {}): OsnovaSpec => ({
  specId: 'test-spec',
  modules: [],
  mainModule: 'главная',
  types: [],
  procedures: [],
  syscalls: [],
  conventions: {},
  ...overrides,
});

describe('runGoldenCheck — smoke сценарии', () => {
  it('спека 1: простой вывод строки — qualityScore >= 0.9', async () => {
    const source = `
модуль привет_мир

процедура главная()
  система.лог.вывести("Привет, мир!")
конец
    `.trim();
    const compiled = compileSource(source);
    expect(compiled.compilerSuccess).toBe(true);
    const report = await runGoldenCheck(compiled.module, makeSpec({
      syscalls: ['система.лог.вывести'],
    }));
    expect(report.executed).toBe(true);
    expect(report.qualityScore).toBeGreaterThanOrEqual(0.9);
    expect(report.passed).toBe(true);
  });

  it('спека 2: массив из 5 чисел, сумма через цикл, expectedReturnValue = 15', async () => {
    const source = `
модуль сумма_массива

процедура главная()
  пусть массив = система.массив.создать()
  система.массив.добавить(массив, 1)
  система.массив.добавить(массив, 2)
  система.массив.добавить(массив, 3)
  система.массив.добавить(массив, 4)
  система.массив.добавить(массив, 5)
  пусть сумма = 0
  пусть idx = 0
  пока idx < 5
    сумма = сумма + система.массив.получить(массив, idx)
    idx = idx + 1
  конец
  вернуть сумма
конец
    `.trim();
    const compiled = compileSource(source);
    expect(compiled.compilerSuccess).toBe(true);
    const report = await runGoldenCheck(compiled.module, makeSpec({
      mainModule: 'главная',
      syscalls: [
        'система.массив.создать',
        'система.массив.добавить',
        'система.массив.получить',
      ],
      expectedReturnValue: 15,
    }));
    expect(report.executed).toBe(true);
    expect(report.qualityScore).toBeGreaterThanOrEqual(0.9);
    expect(report.passed).toBe(true);
  });

  it('спека 3: хранилище — запись и проверка storageWriteVerified', async () => {
    const source = `
модуль счётчик

процедура главная()
  система.хранилище.записать("счёт", "42")
  вернуть 42
конец
    `.trim();
    const compiled = compileSource(source);
    expect(compiled.compilerSuccess).toBe(true);
    const report = await runGoldenCheck(compiled.module, makeSpec({
      mainModule: 'главная',
      syscalls: ['система.хранилище.записать'],
      expectedReturnValue: 42,
    }));
    expect(report.executed).toBe(true);
    expect(report.passed).toBe(true);
    expect(report.qualityScore).toBeGreaterThanOrEqual(0.9);
  });
});
