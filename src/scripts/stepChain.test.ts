/**
 * Оракул цепочки `npm test`: падение шага не отменяет остальные.
 *
 * Здесь проверяется ровно то свойство, из-за отсутствия которого находка сторожа
 * счёта файлов была скрыта: при красном vitest сторожа всё равно выполняются, а
 * код возврата `npm test` остаётся 1.
 *
 * Две проверки намеренно разные:
 *  1. логика — на подставном `run` (видно, что вызваны ВСЕ команды и в порядке);
 *  2. поведение — на НАСТОЯЩИХ процессах (первый шаг падает, второй пишет файл:
 *     файл существует ⇒ второй шаг действительно выполнился, а не «был задуман»).
 */
import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { runSteps } from './stepChain';
import { TEST_STEPS, runStepInherit } from './testChain';

describe('runSteps: шаги независимы', () => {
  it('падение первого шага не отменяет остальные и даёт код 1', () => {
    const called: string[] = [];
    const codes: Record<string, number> = { 'vitest': 1, 'сторож-1': 0, 'сторож-2': 0 };
    const outcome = runSteps(['vitest', 'сторож-1', 'сторож-2'], (c) => {
      called.push(c);
      return codes[c] ?? 0;
    }, () => {});
    expect(called, 'вызваны ВСЕ шаги, включая сторожа после падения').toEqual([
      'vitest',
      'сторож-1',
      'сторож-2',
    ]);
    expect(outcome.failed).toEqual(['vitest']);
    expect(outcome.code).toBe(1);
    expect(outcome.steps.map((s) => s.ok)).toEqual([false, true, true]);
  });

  it('все шаги зелёные → код 0', () => {
    const outcome = runSteps(['a', 'b'], () => 0, () => {});
    expect(outcome.code).toBe(0);
    expect(outcome.failed).toEqual([]);
  });

  it('красный последний шаг тоже даёт код 1 (порядок не важен)', () => {
    const outcome = runSteps(['a', 'b'], (c) => (c === 'b' ? 2 : 0), () => {});
    expect(outcome.code).toBe(1);
    expect(outcome.failed).toEqual(['b']);
  });

  it('в отчёт попадает каждый шаг и итог', () => {
    const lines: string[] = [];
    runSteps(['vitest', 'сторож'], (c) => (c === 'vitest' ? 1 : 0), (l) => lines.push(l));
    expect(lines.some((l) => l.includes('vitest') && l.includes('КРАСНО'))).toBe(true);
    expect(lines.some((l) => l.includes('сторож') && l.includes('OK'))).toBe(true);
    expect(lines.some((l) => l.includes('ИТОГ') && l.includes('красных 1'))).toBe(true);
  });

  it('шаги `npm test` — это vitest, сторож счёта файлов и схема языка', () => {
    expect(TEST_STEPS[0]).toContain('vitest run');
    expect(TEST_STEPS[1]).toBe('npm run check:test-files');
    expect(TEST_STEPS[2]).toBe('npm run check:language-schema');
  });
});

describe('runStepInherit: настоящее падение и настоящий сторож', () => {
  it('красный процесс не мешает следующему записать файл', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'osnova-chain-'));
    const failScript = path.join(dir, 'падает.js');
    const guardScript = path.join(dir, 'сторож.js');
    const marker = path.join(dir, 'сторож-отработал');
    fs.writeFileSync(failScript, 'process.exit(1);\n', 'utf-8');
    fs.writeFileSync(
      guardScript,
      `require('fs').writeFileSync(${JSON.stringify(marker)}, '1');\n`,
      'utf-8',
    );

    const outcome = runSteps(
      [`node ${JSON.stringify(failScript)}`, `node ${JSON.stringify(guardScript)}`],
      runStepInherit,
      () => {},
    );

    expect(fs.existsSync(marker), 'второй шаг выполнился, хотя первый упал').toBe(true);
    expect(outcome.code).toBe(1);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
