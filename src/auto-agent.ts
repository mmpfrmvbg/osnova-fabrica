import { run_patch_agent } from './patch-agent/index.js';
import * as fs from 'fs';

const DECISIONS_PATH = 'runs/decisions.jsonl';

const TASKS = [
  {
    id: 'I-2',
    task: 'Добавить schema-validation трейсов через Zod в src/trace/traceStore.ts — невалидные записи не попадают в датасет. Использовать zod для валидации структуры трейса перед записью.',
    allowed_paths: ['src/trace/traceStore.ts'],
    forbidden_paths: ['src/compiler/language-registry.ts'],
    context_files: ['src/pipeline/types.ts'],
    acceptance_criteria: [
      'В traceStore.ts появляется zod-схема трейса',
      'Невалидные записи пропускаются с console.warn',
    ],
    max_files_changed: 2,
    must_run_before_commit: [],
  },
  {
    id: 'I-3',
    task: 'Добавить мета-поля repairAttempts, semanticErrorCount, traceId, category в экспорт датасета src/scripts/export-dataset.ts',
    allowed_paths: ['src/scripts/export-dataset.ts'],
    forbidden_paths: ['src/compiler/language-registry.ts'],
    context_files: ['src/pipeline/types.ts'],
    acceptance_criteria: [
      'В экспортируемых записях присутствуют поля repairAttempts, semanticErrorCount, traceId, category',
    ],
    max_files_changed: 1,
    must_run_before_commit: [],
  },
  {
    id: 'I-4',
    task: 'Нормализовать calcHealthScore() до [0, 1] через Math.max(0, Math.min(1, score)) в src/scripts/analyze-language-health.ts',
    allowed_paths: ['src/scripts/analyze-language-health.ts'],
    forbidden_paths: ['src/compiler/language-registry.ts'],
    context_files: [],
    acceptance_criteria: [
      'calcHealthScore возвращает значение строго в диапазоне [0, 1]',
    ],
    max_files_changed: 1,
    must_run_before_commit: [],
  },
];

function loadDone(): Set<string> {
  const done = new Set<string>();
  if (!fs.existsSync(DECISIONS_PATH)) return done;
  for (const line of fs.readFileSync(DECISIONS_PATH, 'utf-8').split('\n').filter(Boolean)) {
    try {
      const rec = JSON.parse(line);
      if (rec.status === 'success') done.add(rec.id);
    } catch {}
  }
  return done;
}

function saveDecision(id: string, status: string, detail: string) {
  const rec = { id, status, detail, timestamp: new Date().toISOString() };
  fs.appendFileSync(DECISIONS_PATH, JSON.stringify(rec) + '\n');
  console.log(`[${id}] ${status}: ${detail.slice(0, 120)}`);
}

async function main() {
  const done = loadDone();
  console.log(`Уже выполнено: ${[...done].join(', ') || 'ничего'}`);

  for (const task of TASKS) {
    if (done.has(task.id)) {
      console.log(`[${task.id}] пропускаем — уже выполнено`);
      continue;
    }
    console.log(`\n=== [${task.id}] Запускаю: ${task.task.slice(0, 60)}...`);
    try {
      const result = await run_patch_agent(task);
      if (result.status === 'success') {
        saveDecision(task.id, 'success', result.commitSha ?? '');
      } else {
        saveDecision(task.id, 'failed', JSON.stringify(result));
        console.log(`[${task.id}] СТОП — задача провалилась`);
        break;
      }
    } catch (e: any) {
      saveDecision(task.id, 'error', e.message);
      console.log(`[${task.id}] ОШИБКА — ${e.message}`);
      break;
    }
  }
  console.log('\nГотово. Проверь runs/decisions.jsonl');
}

main().catch(console.error);
