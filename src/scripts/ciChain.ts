#!/usr/bin/env node
/**
 * `npm run ci`: все шаги запускаются независимо, код возврата — 1, если красный
 * хотя бы один.
 *
 * Зачем. `ci` был записан цепочкой `… && npm test && npm run lint && …`: первое
 * падение (а на этой ветке это всегда 10 e2k-падений vitest) обрывало цепочку, и
 * всё, что после него, не запускалось ни разу. Так был скрыт красный
 * `validate:spec` — он стоял после `npm test` и не выполнялся никогда.
 *
 * Это тот же дефект, что был у `npm test` (см. `testChain.ts`), и лечится так же.
 * Разница: `ci` дополнительно ставит зависимости Osiris и гоняет покрытие, поэтому
 * список шагов свой.
 *
 * Запуск: npm run ci
 */

import { runSteps } from './stepChain';
import { runStepInherit } from './testChain';

/** Шаги `npm run ci` в порядке выполнения — как в прежней записи через `&&`. */
export const CI_STEPS: readonly string[] = [
  'npm --prefix apps/osiris ci --no-audit',
  'npm run typecheck',
  'npm test',
  'npm run lint',
  'npx tsx src/scripts/check-yaml-drift.ts',
  'npm run docs:check',
  'cross-env OSNOVA_STORAGE_ROOT=/tmp/osnova-storage-ci npm run golden',
  'npm run gate:reorder',
  'npm run report:deprecated-end',
  'npm run validate:spec',
  'cross-env OSNOVA_STORAGE_ROOT=/tmp/osnova-storage-ci npm run coverage',
];

export function main(): number {
  return runSteps(CI_STEPS, runStepInherit).code;
}

if (require.main === module) {
  process.exit(main());
}
