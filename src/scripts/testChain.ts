#!/usr/bin/env node
/**
 * `npm test`: vitest + сторожа, каждый шаг независимо.
 *
 * Раньше было `vitest && check:test-files && check:language-schema`. Полный
 * прогон на этой ветке красный по 10 e2k-долгам, поэтому сторожа не запускались
 * ни разу, и находка сторожа счёта файлов была скрыта знаком `&&`. Теперь все три
 * шага выполняются всегда, а код возврата — 1, если красным оказался хотя бы один.
 *
 * Отчёт vitest перед прогоном стирается: иначе сторож счёта файлов мог бы пройти
 * по отчёту ПРЕДЫДУЩЕГО прогона, а не по текущему.
 *
 * Запуск: npx tsx src/scripts/testChain.ts (он же `npm test`).
 */

import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { runSteps } from './stepChain';

const ROOT = path.resolve(__dirname, '..', '..');
const VITEST_REPORT = path.join(ROOT, '.tmp', 'vitest-report.json');

/** Шаги `npm test` в порядке выполнения. */
export const TEST_STEPS: readonly string[] = [
  'vitest run --reporter=default --reporter=json --outputFile=.tmp/vitest-report.json',
  'npm run check:test-files',
  'npm run check:language-schema',
];

/** Запуск с наследованием вывода: шаг виден в логе целиком. */
export function runStepInherit(command: string): number {
  const result = spawnSync(command, { shell: true, stdio: 'inherit', cwd: ROOT });
  if (result.error) {
    console.error(`[шаги] не удалось запустить «${command}»: ${result.error.message}`);
    return 1;
  }
  return result.status ?? 1;
}

export function main(): number {
  fs.rmSync(VITEST_REPORT, { force: true });
  return runSteps(TEST_STEPS, runStepInherit).code;
}

if (require.main === module) {
  process.exit(main());
}
