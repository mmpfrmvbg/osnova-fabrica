#!/usr/bin/env ts-node
// ============================================================
// src/cli.ts — Точка входа osnova-fabrica
// Использование: osnova-fabrica --task "сделай TODO-лист"
// ============================================================

import { runPipeline } from './pipeline/orchestrator';
import { validateEnv } from './env';

const args = process.argv.slice(2);
const taskIdx = args.indexOf('--task');

if (taskIdx === -1 || !args[taskIdx + 1]) {
  console.error('Использование: osnova-fabrica --task "описание задачи"');
  console.error('Пример:        osnova-fabrica --task "сделай TODO-лист с хранилищем"');
  process.exit(1);
}

const task = args[taskIdx + 1];

validateEnv();

console.log(`\n[osnova-fabrica] Задача: ${task}\n`);

runPipeline(task)
  .then(result => {
    console.log('\n─── Результат ───');
    console.log('Статус:         ', result.status);
    console.log('Файл:           ', result.source?.filename ?? '—');
    console.log('Repair попыток: ', result.repairAttempts);
    console.log('Время:          ', result.totalDurationMs, 'ms');

    if (result.status === 'success') {
      console.log('Golden:          passed ✅');
    } else if (result.status === 'partial') {
      console.log(`Quality score:   ${result.goldenReport?.qualityScore?.toFixed(2)} ⚠️`);
    } else if (result.error) {
      console.error('Ошибка:         ', result.error);
    }

    if (result.source) {
      console.log('\n─── Сгенерированный .osnova ───');
      console.log(result.source.source);
    }

    process.exit(result.status === 'failure' ? 1 : 0);
  })
  .catch(err => {
    console.error('[fatal]', err);
    process.exit(1);
  });
